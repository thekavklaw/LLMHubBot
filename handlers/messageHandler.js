const { EmbedBuilder } = require('discord.js');
const { getSystemPrompt, getSoulConfig, reflectAndUpdate } = require('../soul');
const { generateResponse } = require('../openai-client');
const { addMessage, getContext, getRecentContextMessages, withChannelLock } = require('../context');
const { logMessage, getState, setState } = require('../db');
const { shouldRespond } = require('../relevance');
const { storeMemory, extractFacts } = require('../memory');
const { trackUser, updateProfilesFromFacts } = require('../users');
const { checkMessage, checkOutput } = require('../moderator');
const { checkRateLimit } = require('../ratelimiter');
const config = require('../config');
const logger = require('../logger');
const TaskQueue = require('../queue');

const apiQueue = new TaskQueue(config.maxConcurrentApi);

const channelMsgCounts = new Map();
let globalMsgCount = parseInt(getState('global_msg_count') || '0', 10);
const userNameToId = new Map();

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
  return false;
}

function isGptThread(channel) {
  return channel.isThread() && channel.parentId === config.gptChannelId;
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

async function handleMessage(message) {
  try {
    if (message.author.bot) return;
    if (!isGptChannel(message.channel)) return;

    const channelId = message.channel.id;
    const userId = message.author.id;
    const userName = message.author.username;
    const displayName = message.member?.displayName || userName;
    const inThread = isGptThread(message.channel);

    trackUser(userId, userName, displayName);
    userNameToId.set(userName, userId);

    // Build content: string or array (for vision)
    let userContent;
    if (imageUrls.length > 0) {
      userContent = [];
      if (message.content.trim()) userContent.push({ type: 'text', text: message.content });
      for (const url of imageUrls) {
        userContent.push({ type: 'image_url', image_url: { url } });
      }
    } else {
      userContent = message.content;
    }

    addMessage(channelId, 'user', userContent, userName);
    logMessage(channelId, userId, userName, 'user', message.content);

    // Extract image attachments for vision
    const IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
    const imageUrls = [...message.attachments.values()]
      .filter(a => {
        const ext = (a.name || '').split('.').pop()?.toLowerCase();
        return IMAGE_TYPES.includes(ext) || (a.contentType && a.contentType.startsWith('image/'));
      })
      .map(a => a.url);

    if (message.content.trim().length < 1 && imageUrls.length === 0) return;

    const rateResult = checkRateLimit(userId, channelId, inThread, message.member);
    if (!rateResult.allowed) {
      logger.info('RateLimit', `Blocked ${userName} (retry in ${rateResult.retryAfter}s)`);
      try {
        await message.channel.send({ embeds: [
          new EmbedBuilder()
            .setColor(0xFEE75C)
            .setDescription(`⏳ Slow down! Try again in ${rateResult.retryAfter}s.`)
        ]});
      } catch (_) {}
      return;
    }

    const modResult = await checkMessage(message, imageUrls);
    if (!modResult.safe) return;

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

    if (!inThread && message.channel.id === config.gptChannelId && config.features.relevanceCheck) {
      try {
        const recentMessages = getRecentContextMessages(channelId);
        const decision = await shouldRespond(message, recentMessages, message.client.user.id);
        logger.debug('Relevance', `${userName}: "${message.content.slice(0, 60)}" → respond=${decision.respond} (${decision.confidence}) — ${decision.reason}`);
        if (!decision.respond) return;
      } catch (err) {
        logger.error('Relevance', 'Error:', err);
      }
    }

    // Queue the API call with timeout
    const soulConfig = getSoulConfig();

    const response = await apiQueue.enqueue(async () => {
      const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
      const messages = [
        { role: 'system', content: systemPrompt },
        ...getContext(channelId),
      ];

      try { await message.channel.sendTyping(); } catch (_) {}

      // Timeout wrapper
      return Promise.race([
        generateResponse(messages, soulConfig),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT')), config.apiTimeoutMs)
        ),
      ]);
    });

    const outMod = await checkOutput(response, channelId);
    if (!outMod.safe) {
      logger.warn('Moderator', 'Blocked outgoing response');
      await message.channel.send({ embeds: [errorEmbed("I generated a response but it was flagged by moderation. Let me try a different approach.")] }).catch(() => {});
      return;
    }

    addMessage(channelId, 'assistant', response);
    logMessage(channelId, null, 'LLMHub', 'assistant', response);

    for (const part of splitMessage(response)) {
      await message.channel.send(part);
    }
  } catch (err) {
    errorCount++;
    updateHealth();
    if (err.message === 'TIMEOUT') {
      logger.warn('MessageHandler', 'OpenAI timeout');
      try {
        await message.channel.send({ embeds: [errorEmbed("Sorry, I'm a bit busy right now. Try again in a moment.")] });
      } catch (_) {}
    } else {
      logger.error('MessageHandler', 'Error:', err);
      try {
        await message.channel.send({ embeds: [errorEmbed("Sorry, I encountered an error. Try again in a moment.")] });
      } catch (_) {}
    }
  }
}

module.exports = { handleMessage, updateHealth, userNameToId, getStats: () => ({ messageCount, errorCount, globalMsgCount, queueStats: apiQueue.getStats() }) };
