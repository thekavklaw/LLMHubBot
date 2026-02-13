/**
 * @module handlers/messageHandler
 * @description Core message processing pipeline. Handles debouncing, moderation,
 * context management, and routes messages through the 5-layer thinking system
 * or legacy fallback paths. Manages per-model queuing and backpressure.
 */

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getSystemPrompt, getSoulConfig, reflectAndUpdate } = require('../soul');
const { generateResponse, generateImage } = require('../openai-client');

let _agentLoop = null;
let _orchestrator = null;
function setAgentLoop(loop) { _agentLoop = loop; }
function setOrchestrator(orch) { _orchestrator = orch; }
const { addMessage, getContext, getRecentContextMessages, withChannelLock, updateMessage, deleteMessage } = require('../context');
const { logMessage, getState, setState } = require('../db');
// Legacy imports removed (thinking.js, relevance.js, webSearch.js) — 5-layer system is canonical
const { storeMemory, extractFacts, searchMemory } = require('../memory');
const { trackUser, updateProfilesFromFacts, getProfile } = require('../users');
const { checkMessage, checkOutput } = require('../moderator');
const { checkRateLimit } = require('../ratelimiter');
const config = require('../config');
const logger = require('../logger');
const { ModelQueue } = require('../utils/model-queue');
const MessageDebouncer = require('../utils/debouncer');
const { friendlyError } = require('../utils/errors');
const { recordProcessed, recordError: recordHealthError } = require('../health');

// ── Per-model queue system ──
const modelQueue = new ModelQueue({
  mainConcurrency: config.maxConcurrentApi || 8,
  miniConcurrency: 15,
  imageConcurrency: 3,
  modConcurrency: 20,
  mainMaxDepth: 50,
  miniMaxDepth: 100,
  imageMaxDepth: 10,
  modMaxDepth: 100,
});

// ── Message debouncer (3s window) ──
const debouncer = new MessageDebouncer(3000);

const channelMsgCounts = new Map();
let globalMsgCount = parseInt(getState('global_msg_count') || '0', 10);
const userNameToId = new Map();

// Image rate limiting per user
const imageRateLimits = new Map(); // userId -> [{timestamp}]

// Health stats
let messageCount = 0;
let errorCount = 0;
const startTime = Date.now();

function updateHealth() {
  try {
    setState('uptime_since', new Date(startTime).toISOString());
    setState('message_count', String(messageCount));
    setState('error_count', String(errorCount));
  } catch (_) {}
}

function isGptChannel(channel) {
  if (channel.id === config.gptChannelId) return true;
  if (channel.isThread() && channel.parentId === config.gptChannelId) return true;
  const allowedChannels = config.allowedChannelIds;
  if (allowedChannels.length > 0) {
    if (allowedChannels.includes(channel.id)) return true;
    if (channel.isThread() && allowedChannels.includes(channel.parentId)) return true;
  }
  return false;
}

function isGptThread(channel) {
  if (!channel.isThread()) return false;
  if (channel.parentId === config.gptChannelId) return true;
  const allowedChannels = config.allowedChannelIds;
  if (allowedChannels.length > 0 && allowedChannels.includes(channel.parentId)) return true;
  return false;
}

function splitMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  while (text.length > 0) {
    let splitAt = maxLen;
    if (text.length > maxLen) {
      const lastNewline = text.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.5) splitAt = lastNewline;
    }
    parts.push(text.slice(0, splitAt));
    text = text.slice(splitAt);
  }
  return parts;
}

function errorEmbed(description) {
  return new EmbedBuilder()
    .setColor(0xED4245)
    .setDescription(`❌ ${description}`)
    .setTimestamp();
}

/**
 * Determine message priority for queue ordering.
 * 3 = bot mentioned, 2 = reply to bot, 1 = thread, 0 = ambient
 */
function getMessagePriority(message, botId) {
  if (message.mentions?.has(botId)) return 3;
  if (message.reference?.messageId) {
    // Check if replying to bot's message
    const referenced = message.channel.messages?.cache?.get(message.reference.messageId);
    if (referenced?.author?.id === botId) return 2;
  }
  if (message.channel.isThread()) return 1;
  return 0;
}

/**
 * Start persistent typing indicator. Returns stop function.
 */
function startTyping(channel) {
  channel.sendTyping().catch(() => {});
  const interval = setInterval(() => {
    channel.sendTyping().catch(() => {});
  }, 9000);
  return () => clearInterval(interval);
}

/**
 * Check if user can generate an image (rate limit).
 */
function canGenerateImage(userId) {
  if (!config.enableImageGeneration) return false;
  const now = Date.now();
  const hourAgo = now - 3600000;
  let timestamps = imageRateLimits.get(userId) || [];
  timestamps = timestamps.filter(t => t > hourAgo);
  imageRateLimits.set(userId, timestamps);
  return timestamps.length < config.maxImagesPerUserPerHour;
}

function recordImageGeneration(userId) {
  const timestamps = imageRateLimits.get(userId) || [];
  timestamps.push(Date.now());
  imageRateLimits.set(userId, timestamps);
}

async function runFactExtraction(channelId) {
  try {
    const recentMsgs = getRecentContextMessages(channelId);
    if (recentMsgs.length < 5) return;
    logger.info('Memory', `Extracting facts from ${recentMsgs.length} messages in ${channelId}...`);
    const facts = await extractFacts(recentMsgs, channelId);
    if (facts.length === 0) return;
    logger.info('Memory', `Extracted ${facts.length} facts`);
    const guildId = recentMsgs[0]?.guildId || null;
    for (const fact of facts) {
      const userId = fact.userName ? userNameToId.get(fact.userName) : null;
      await storeMemory(fact.content, { userId, userName: fact.userName, channelId, category: fact.category, guildId });
    }
    updateProfilesFromFacts(facts, userNameToId);
  } catch (err) {
    logger.error('FactExtraction', 'Error:', err);
  }
}

/**
 * Core message processing (called after debounce).
 */
async function processMessage(message, content, mergedAttachments) {
  try {
    const channelId = message.channel.id;
    const userId = message.author.id;
    const userName = message.author.username;
    const displayName = message.member?.displayName || userName;
    const guildId = message.guild?.id || null;
    const inThread = isGptThread(message.channel);
    const botId = message.client.user.id;
    const priority = getMessagePriority(message, botId);

    trackUser(userId, userName, displayName);
    userNameToId.set(userName, userId);

    // Extract image attachments for vision (use merged attachments from debouncer if available)
    const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
    const attachmentSource = mergedAttachments || [...message.attachments.values()];
    const imageUrls = attachmentSource
      .filter(a => {
        const ext = (a.name || '').split('.').pop()?.toLowerCase();
        return IMAGE_TYPES.includes(ext) || (a.contentType && a.contentType.startsWith('image/'));
      })
      .map(a => a.url);

    // Build content: string or array (for vision)
    let userContent;
    if (imageUrls.length > 0) {
      userContent = [];
      if (content.trim()) userContent.push({ type: 'text', text: content });
      for (const url of imageUrls) {
        userContent.push({ type: 'image_url', image_url: { url } });
      }
    } else {
      userContent = content;
    }

    if (content.trim().length < 1 && imageUrls.length === 0) return;

    const rateResult = checkRateLimit(userId, channelId, inThread, message.member);
    if (!rateResult.allowed) {
      logger.warn('MessageHandler', `Rate limited ${userName} (retry in ${rateResult.retryAfter}s)`);
      try {
        await message.channel.send({ embeds: [
          new EmbedBuilder()
            .setColor(0xFEE75C)
            .setDescription(`⏳ Slow down! Try again in ${rateResult.retryAfter}s.`)
        ]});
      } catch (_) {}
      return;
    }

    // Moderation check BEFORE adding to context
    const modResult = await checkMessage(message, imageUrls);
    if (!modResult.safe) {
      logger.warn('MessageHandler', `Message from ${userName} blocked by moderation`);
      return;
    }

    // Only add to context/DB AFTER moderation passes
    await addMessage(channelId, 'user', userContent, userName, message.id);
    logMessage(channelId, userId, userName, 'user', content);

    messageCount++;
    const chCount = (channelMsgCounts.get(channelId) || 0) + 1;
    channelMsgCounts.set(channelId, chCount);
    globalMsgCount++;
    setState('global_msg_count', String(globalMsgCount));
    updateHealth();

    if (chCount % config.factExtractionInterval === 0) {
      runFactExtraction(channelId).catch(err => logger.error('BackgroundExtraction', 'Error:', err));
    }

    if (globalMsgCount % config.reflectionInterval === 0 && config.features.soulReflection) {
      reflectAndUpdate().catch(err => logger.error('BackgroundReflection', 'Error:', err));
    }

    // ── Check if queue is full before enqueueing ──
    if (modelQueue.isQueueFull(config.model)) {
      logger.warn('MessageHandler', `Queue full, rejecting message from ${userName}`);
      await message.channel.send("I'm a bit busy right now! Give me a moment and try again. 🕐").catch(() => {});
      return;
    }

    // ── Backpressure signaling ──
    const queueStats = modelQueue.getStats();
    const mainQueue = queueStats.main;
    const isQueued = mainQueue.active >= 8; // will be queued, not immediate
    if (isQueued) {
      try { await message.react('⏳'); } catch (_) {}
    }

    // ── 5-Layer Thinking System or Legacy Fallback ──
    if (_orchestrator && config.thinkingLayersEnabled) {
      const mentionsBot = message.mentions?.has(botId);
      const repliesToBot = message.reference?.messageId &&
        message.channel.messages?.cache?.get(message.reference.messageId)?.author?.id === botId;

      // Check if the bot recently spoke in this channel (active conversation detection)
      let botRecentlySpokeInChannel = false;
      let lastBotMessageInChannel = null;
      try {
        const recentMessages = message.channel.messages?.cache
          ?.filter(m => m.author?.id === botId && Date.now() - m.createdTimestamp < 120000)
          ?.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
        if (recentMessages?.size > 0) {
          botRecentlySpokeInChannel = true;
          const lastMsg = recentMessages.first();
          lastBotMessageInChannel = { content: lastMsg.content, timestamp: lastMsg.createdTimestamp };
        }
      } catch (_) {}

      const stopTyping = startTyping(message.channel);

      // "Still thinking..." message after 5s
      let thinkingMsg = null;
      const thinkingTimer = setTimeout(async () => {
        try { thinkingMsg = await message.channel.send('💭 *Still thinking...*'); } catch (_) {}
      }, 5000);

      try {
        const orchestratorResult = await modelQueue.enqueue(config.model, () =>
          _orchestrator.process(message, {
            userId,
            userName,
            displayName,
            channelId,
            guildId,
            botId,
            inThread,
            mentionsBot,
            repliesToBot,
            botRecentlySpokeInChannel,
            lastBotMessageInChannel,
            gptChannelId: config.gptChannelId,
          }),
          priority
        );

        stopTyping();
        clearTimeout(thinkingTimer);
        if (thinkingMsg) { try { await thinkingMsg.delete(); } catch (_) {} }

        // Remove backpressure emoji
        if (isQueued) {
          try { await message.reactions.cache.get('⏳')?.users?.remove(botId); } catch (_) {}
        }

        if (orchestratorResult.action === 'ignore') {
          logger.debug('Orchestrator', `Ignoring ${userName}: ${orchestratorResult.reason}`);
          return;
        }

        // Track image rate limits
        if (orchestratorResult.images) {
          for (const _ of orchestratorResult.images) {
            recordImageGeneration(userId);
          }
        }

        // Moderation check on text
        if (orchestratorResult.text) {
          const outMod = await checkOutput(orchestratorResult.text, channelId);
          if (!outMod.safe) {
            await message.channel.send({ embeds: [errorEmbed("Response flagged by moderation.")] }).catch(() => {});
            return;
          }
        }

        // Log to context + DB
        await addMessage(channelId, 'assistant', orchestratorResult.text || '[image]');
        logMessage(channelId, null, 'LLMHub', 'assistant', orchestratorResult.text || '[image]');

        // Send Discord messages
        for (const msg of orchestratorResult.messages || []) {
          try {
            if (msg.delayMs && msg.delayMs > 0) {
              await message.channel.sendTyping().catch(() => {});
              await new Promise(r => setTimeout(r, msg.delayMs));
            }
            const payload = {};
            if (msg.content) payload.content = msg.content;
            if (msg.files && msg.files.length > 0) payload.files = msg.files;
            if (msg.embeds && msg.embeds.length > 0) payload.embeds = msg.embeds;
            if (payload.content || payload.files || payload.embeds) {
              await message.channel.send(payload);
            }
          } catch (sendErr) {
            logger.error('MessageHandler', `Failed to send message part: ${sendErr.message}`);
          }
        }
        // First-time user tip
        try {
          const profile = getProfile(userId);
          if (!profile || !profile.message_count || profile.message_count <= 1) {
            await message.channel.send("💡 *Tip: Use `/help` to see everything I can do!*");
          }
        } catch (_) {}

        recordProcessed();
        const responsePreview = (orchestratorResult.text || '[image]').slice(0, 80);
        logger.info('MessageHandler', `Response sent to ${channelId}: "${responsePreview}" (${(orchestratorResult.text || '').length} chars)`);
      } catch (err) {
        stopTyping();
        clearTimeout(thinkingTimer);
        if (thinkingMsg) { try { await thinkingMsg.delete(); } catch (_) {} }
        if (isQueued) {
          try { await message.reactions.cache.get('⏳')?.users?.remove(botId); } catch (_) {}
        }
        throw err;
      }
    } else {
      // ── Legacy fallback: simple text response (5-layer system should always be active) ──
      logger.warn('MessageHandler', 'Orchestrator not available — using basic text response fallback');
      const soulConfig = getSoulConfig();
      await handleTextResponse(message, channelId, userId, userName, soulConfig, priority);
    }

  } catch (err) {
    errorCount++;
    updateHealth();
    recordHealthError();
    logger.error('MessageHandler', 'Error:', err);
    try {
      await message.channel.send({ embeds: [errorEmbed(friendlyError(err))] });
    } catch (_) {}
  }
}

/**
 * Entry point — applies debouncing before processing.
 */
async function handleMessage(message) {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (config.allowedGuildId && message.guild.id !== config.allowedGuildId) return;

    const allowedChannels = config.allowedChannelIds;
    if (allowedChannels.length > 0) {
      const channelId = message.channel.id;
      const parentId = message.channel.parentId;
      if (!allowedChannels.includes(channelId) && !allowedChannels.includes(parentId)) return;
    }

    if (!isGptChannel(message.channel)) return;

    logger.info('MessageHandler', `Message received: ${message.author.username} in ${message.channel.id} (${message.channel.isThread() ? 'thread' : 'channel'})`);

    // Cap input length to prevent token budget blowout
    const MAX_MESSAGE_LENGTH = 4000;
    if (message.content && message.content.length > MAX_MESSAGE_LENGTH) {
      await message.reply('⚠️ That message is too long for me to process. Could you shorten it a bit? (Max ~4000 characters)');
      return;
    }

    // Debounce: coalesce rapid messages from same user+channel
    debouncer.add(message, (lastMessage, combinedContent, allAttachments) => {
      processMessage(lastMessage, combinedContent, allAttachments).catch(err => {
        logger.error('MessageHandler', 'Debounced processing error:', err);
      });
    });
  } catch (err) {
    logger.error('MessageHandler', 'Pre-processing error:', err);
  }
}

/**
 * Standard text-only response.
 */
async function handleTextResponse(message, channelId, userId, userName, soulConfig, priority = 0) {
  const response = await modelQueue.enqueue(config.model, async () => {
    const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...getContext(channelId),
    ];
    const stopTyping = startTyping(message.channel);
    try {
      return await Promise.race([
        generateResponse(messages, soulConfig),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), config.apiTimeoutMs)),
      ]);
    } finally {
      stopTyping();
    }
  }, priority);

  const outMod = await checkOutput(response, channelId);
  if (!outMod.safe) {
    logger.warn('Moderator', 'Blocked outgoing response');
    await message.channel.send({ embeds: [errorEmbed("I generated a response but it was flagged by moderation.")] }).catch(() => {});
    return;
  }

  await addMessage(channelId, 'assistant', response);
  logMessage(channelId, null, 'LLMHub', 'assistant', response);

  for (const part of splitMessage(response)) {
    await message.channel.send(part);
  }
}

// Legacy handlers (handleSearchAndRespond, handleGenerateImage, handleRespondWithImage,
// handleAgentResponse) removed — all routing now goes through the 5-layer orchestrator.

module.exports = {
  handleMessage,
  setAgentLoop,
  setOrchestrator,
  updateHealth,
  userNameToId,
  modelQueue,
  debouncer,
  getStats: () => ({
    messageCount,
    errorCount,
    globalMsgCount,
    queueStats: modelQueue.getStats(),
  }),
};
