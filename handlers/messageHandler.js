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
const { shouldRespond } = require('../relevance');
const { think } = require('../thinking');
const { storeMemory, extractFacts, searchMemory } = require('../memory');
const { trackUser, updateProfilesFromFacts, getProfile } = require('../users');
const { checkMessage, checkOutput } = require('../moderator');
const { checkRateLimit } = require('../ratelimiter');
const { searchWeb } = require('../tools/webSearch');
const config = require('../config');
const logger = require('../logger');
const { ModelQueue } = require('../utils/model-queue');
const MessageDebouncer = require('../utils/debouncer');
const { friendlyError } = require('../utils/errors');

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
    for (const fact of facts) {
      const userId = fact.userName ? userNameToId.get(fact.userName) : null;
      await storeMemory(fact.content, { userId, userName: fact.userName, channelId, category: fact.category });
    }
    updateProfilesFromFacts(facts, userNameToId);
  } catch (err) {
    logger.error('FactExtraction', 'Error:', err);
  }
}

/**
 * Core message processing (called after debounce).
 */
async function processMessage(message, content) {
  try {
    const channelId = message.channel.id;
    const userId = message.author.id;
    const userName = message.author.username;
    const displayName = message.member?.displayName || userName;
    const inThread = isGptThread(message.channel);
    const botId = message.client.user.id;
    const priority = getMessagePriority(message, botId);

    trackUser(userId, userName, displayName);
    userNameToId.set(userName, userId);

    // Extract image attachments for vision
    const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
    const imageUrls = [...message.attachments.values()]
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
    addMessage(channelId, 'user', userContent, userName, message.id);
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

      const stopTyping = startTyping(message.channel);

      try {
        const orchestratorResult = await modelQueue.enqueue(config.model, () =>
          _orchestrator.process(message, {
            userId,
            userName,
            displayName,
            channelId,
            botId,
            inThread,
            mentionsBot,
            repliesToBot,
            gptChannelId: config.gptChannelId,
          }),
          priority
        );

        stopTyping();

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
        addMessage(channelId, 'assistant', orchestratorResult.text || '[image]');
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
        const responsePreview = (orchestratorResult.text || '[image]').slice(0, 80);
        logger.info('MessageHandler', `Response sent to ${channelId}: "${responsePreview}" (${(orchestratorResult.text || '').length} chars)`);
      } catch (err) {
        stopTyping();
        if (isQueued) {
          try { await message.reactions.cache.get('⏳')?.users?.remove(botId); } catch (_) {}
        }
        throw err;
      }
    } else {
      // ── Legacy: Thinking Layer or Relevance Fallback ──
      let decision;
      const recentMessages = getRecentContextMessages(channelId);

      if (config.enableThinking) {
        let userProfile = null;
        try { userProfile = getProfile(userId); } catch (_) {}

        let relevantMemories = [];
        try { relevantMemories = await searchMemory(content, 3, 0.6); } catch (_) {}

        decision = await think(recentMessages, userProfile, relevantMemories, inThread, botId);

        if (decision.action === 'ignore') {
          logger.debug('Thinking', `Ignoring message from ${userName}: ${decision.reasoning}`);
          return;
        }
      } else {
        if (!inThread && message.channel.id === config.gptChannelId && config.features.relevanceCheck) {
          try {
            const relevanceDecision = await shouldRespond(message, recentMessages, botId);
            if (!relevanceDecision.respond) return;
          } catch (err) {
            logger.error('Relevance', 'Error:', err);
          }
        }
        decision = { action: 'respond', tone: 'helpful', confidence: 0.5, image_prompt: null, search_query: null };
      }

      const soulConfig = getSoulConfig();

      if (_agentLoop && config.enableAgentLoop) {
        await handleAgentResponse(message, channelId, userId, userName, soulConfig, priority);
      } else if (decision.action === 'search_and_respond') {
        await handleSearchAndRespond(message, channelId, userId, userName, decision, soulConfig, priority);
      } else if (decision.action === 'generate_image') {
        await handleGenerateImage(message, channelId, userId, userName, decision, priority);
      } else if (decision.action === 'respond_with_image') {
        await handleRespondWithImage(message, channelId, userId, userName, decision, soulConfig, priority);
      } else {
        await handleTextResponse(message, channelId, userId, userName, soulConfig, priority);
      }
    }

  } catch (err) {
    errorCount++;
    updateHealth();
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

    // Debounce: coalesce rapid messages from same user+channel
    debouncer.add(message, (lastMessage, combinedContent) => {
      processMessage(lastMessage, combinedContent).catch(err => {
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

  addMessage(channelId, 'assistant', response);
  logMessage(channelId, null, 'LLMHub', 'assistant', response);

  for (const part of splitMessage(response)) {
    await message.channel.send(part);
  }
}

/**
 * Search the web, then respond with search results as context.
 */
async function handleSearchAndRespond(message, channelId, userId, userName, decision, soulConfig, priority = 0) {
  const stopTyping = startTyping(message.channel);

  let searchResults = '';
  try {
    const results = await searchWeb(decision.search_query);
    searchResults = results.map(r => `**${r.title}**\n${r.url}\n${r.snippet}`).join('\n\n');
    logger.info('Thinking', `Web search: "${decision.search_query}" → ${results.length} results`);
  } catch (err) {
    logger.error('Thinking', 'Web search failed:', err.message);
  }

  try {
    const response = await modelQueue.enqueue(config.model, async () => {
      const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
      const contextMessages = [
        { role: 'system', content: systemPrompt },
        ...getContext(channelId),
      ];
      if (searchResults) {
        contextMessages.push({
          role: 'system',
          content: `Web search results for "${decision.search_query}":\n\n${searchResults}\n\nUse these results to inform your response. Cite sources when relevant.`,
        });
      }
      return Promise.race([
        generateResponse(contextMessages, { ...soulConfig, tools: false }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), config.apiTimeoutMs)),
      ]);
    }, priority);

    stopTyping();

    const outMod = await checkOutput(response, channelId);
    if (!outMod.safe) {
      await message.channel.send({ embeds: [errorEmbed("Response flagged by moderation.")] }).catch(() => {});
      return;
    }

    addMessage(channelId, 'assistant', response);
    logMessage(channelId, null, 'LLMHub', 'assistant', response);

    for (const part of splitMessage(response)) {
      await message.channel.send(part);
    }
  } catch (err) {
    stopTyping();
    throw err;
  }
}

/**
 * Generate an image only (no text response).
 */
async function handleGenerateImage(message, channelId, userId, userName, decision, priority = 0) {
  if (!canGenerateImage(userId)) {
    await message.channel.send({ embeds: [errorEmbed("You've hit the image generation limit. Try again later.")] }).catch(() => {});
    return;
  }

  const stopTyping = startTyping(message.channel);

  try {
    const imageBuffer = await modelQueue.enqueue('gpt-image-1', () => generateImage(decision.image_prompt), priority);
    stopTyping();
    recordImageGeneration(userId);

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'generated.png' });
    await message.channel.send({ files: [attachment] });

    addMessage(channelId, 'assistant', `[Generated image: ${decision.image_prompt}]`);
    logMessage(channelId, null, 'LLMHub', 'assistant', `[Image: ${decision.image_prompt}]`);

    storeMemory(`User ${userName} requested a visual/image about: ${decision.image_prompt}`, {
      userId, userName, channelId, category: 'preference',
    }).catch(() => {});
  } catch (err) {
    stopTyping();
    logger.error('ImageGen', 'Error:', err.message);
    await message.channel.send({ embeds: [errorEmbed("Failed to generate the image. Try again.")] }).catch(() => {});
  }
}

/**
 * Generate both a text response and an image.
 */
async function handleRespondWithImage(message, channelId, userId, userName, decision, soulConfig, priority = 0) {
  if (!canGenerateImage(userId)) {
    await handleTextResponse(message, channelId, userId, userName, soulConfig, priority);
    return;
  }

  const stopTyping = startTyping(message.channel);

  try {
    const [response, imageResult] = await Promise.allSettled([
      modelQueue.enqueue(config.model, async () => {
        const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
        const messages = [
          { role: 'system', content: systemPrompt },
          ...getContext(channelId),
        ];
        return Promise.race([
          generateResponse(messages, soulConfig),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), config.apiTimeoutMs)),
        ]);
      }, priority),
      modelQueue.enqueue('gpt-image-1', () => generateImage(decision.image_prompt), priority),
    ]);

    stopTyping();

    let textSent = false;
    if (response.status === 'fulfilled' && response.value) {
      const outMod = await checkOutput(response.value, channelId);
      if (outMod.safe) {
        addMessage(channelId, 'assistant', response.value);
        logMessage(channelId, null, 'LLMHub', 'assistant', response.value);

        if (imageResult.status === 'fulfilled') {
          const parts = splitMessage(response.value);
          for (let i = 0; i < parts.length - 1; i++) {
            await message.channel.send(parts[i]);
          }
          recordImageGeneration(userId);
          const attachment = new AttachmentBuilder(imageResult.value, { name: 'generated.png' });
          await message.channel.send({ content: parts[parts.length - 1], files: [attachment] });
          textSent = true;
        } else {
          for (const part of splitMessage(response.value)) {
            await message.channel.send(part);
          }
          textSent = true;
        }
      }
    }

    if (!textSent && imageResult.status === 'fulfilled') {
      recordImageGeneration(userId);
      const attachment = new AttachmentBuilder(imageResult.value, { name: 'generated.png' });
      await message.channel.send({ files: [attachment] });
    }

    if (response.status === 'rejected' && imageResult.status === 'rejected') {
      throw response.reason || new Error('Both text and image generation failed');
    }

    storeMemory(`User ${userName} appreciated a visual response about: ${decision.image_prompt}`, {
      userId, userName, channelId, category: 'preference',
    }).catch(() => {});
  } catch (err) {
    stopTyping();
    throw err;
  }
}

/**
 * Agent loop response — GPT decides when to use tools.
 */
async function handleAgentResponse(message, channelId, userId, userName, soulConfig, priority = 0) {
  const stopTyping = startTyping(message.channel);

  try {
    const result = await modelQueue.enqueue(config.model, async () => {
      const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
      const contextMessages = getContext(channelId);
      const context = { userId, userName, channelId, generatedImages: [] };

      return Promise.race([
        _agentLoop.run(contextMessages, systemPrompt, context),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), config.agentLoopTimeout || 60000)),
      ]);
    }, priority);

    stopTyping();

    if (result.toolsUsed.length > 0) {
      logger.info('AgentLoop', `Used ${result.toolsUsed.length} tools in ${result.iterations} iterations`);
    }

    if (!result.text && result.images.length === 0) return;

    const outMod = await checkOutput(result.text || '', channelId);
    if (!outMod.safe) {
      await message.channel.send({ embeds: [errorEmbed("Response flagged by moderation.")] }).catch(() => {});
      return;
    }

    addMessage(channelId, 'assistant', result.text || '[image]');
    logMessage(channelId, null, 'LLMHub', 'assistant', result.text || '[image]');

    const files = [];
    for (let i = 0; i < result.images.length; i++) {
      const img = result.images[i];
      if (img.image_buffer) {
        const buf = Buffer.from(img.image_buffer, 'base64');
        files.push(new AttachmentBuilder(buf, { name: `generated_${i + 1}.png` }));
        recordImageGeneration(userId);
      }
    }

    if (result.text) {
      const parts = splitMessage(result.text);
      for (let i = 0; i < parts.length - 1; i++) {
        await message.channel.send(parts[i]);
      }
      await message.channel.send({
        content: parts[parts.length - 1],
        files: files.length > 0 ? files : undefined,
      });
    } else if (files.length > 0) {
      await message.channel.send({ files });
    }
  } catch (err) {
    stopTyping();
    throw err;
  }
}

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
