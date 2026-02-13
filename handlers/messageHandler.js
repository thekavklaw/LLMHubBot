const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { getSystemPrompt, getSoulConfig, reflectAndUpdate } = require('../soul');
const { generateResponse, generateImage } = require('../openai-client');

let _agentLoop = null;
function setAgentLoop(loop) { _agentLoop = loop; }
const { addMessage, getContext, getRecentContextMessages, withChannelLock } = require('../context');
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
const TaskQueue = require('../queue');

const apiQueue = new TaskQueue(config.maxConcurrentApi);

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
      if (message.content.trim()) userContent.push({ type: 'text', text: message.content });
      for (const url of imageUrls) {
        userContent.push({ type: 'image_url', image_url: { url } });
      }
    } else {
      userContent = message.content;
    }

    addMessage(channelId, 'user', userContent, userName);
    logMessage(channelId, userId, userName, 'user', message.content);

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

    // ── Thinking Layer or Relevance Fallback ──
    let decision;
    const recentMessages = getRecentContextMessages(channelId);

    if (config.enableThinking) {
      // Get user profile and memories for thinking context
      let userProfile = null;
      try { userProfile = getProfile(userId); } catch (_) {}

      let relevantMemories = [];
      try { relevantMemories = await searchMemory(message.content, 3, 0.6); } catch (_) {}

      decision = await think(recentMessages, userProfile, relevantMemories, inThread, message.client.user.id);

      if (decision.action === 'ignore') {
        logger.debug('Thinking', `Ignoring message from ${userName}: ${decision.reasoning}`);
        return;
      }
    } else {
      // Fallback to old relevance check
      if (!inThread && message.channel.id === config.gptChannelId && config.features.relevanceCheck) {
        try {
          const relevanceDecision = await shouldRespond(message, recentMessages, message.client.user.id);
          logger.debug('Relevance', `${userName}: "${message.content.slice(0, 60)}" → respond=${relevanceDecision.respond} (${relevanceDecision.confidence}) — ${relevanceDecision.reason}`);
          if (!relevanceDecision.respond) return;
        } catch (err) {
          logger.error('Relevance', 'Error:', err);
        }
      }
      decision = { action: 'respond', tone: 'helpful', confidence: 0.5, image_prompt: null, search_query: null };
    }

    // ── Route by Decision ──
    const soulConfig = getSoulConfig();

    // Use agent loop if enabled — it handles tool calling (search, image gen, etc.) automatically
    if (_agentLoop && config.enableAgentLoop) {
      await handleAgentResponse(message, channelId, userId, userName, soulConfig);
    } else if (decision.action === 'search_and_respond') {
      await handleSearchAndRespond(message, channelId, userId, userName, decision, soulConfig);
    } else if (decision.action === 'generate_image') {
      await handleGenerateImage(message, channelId, userId, userName, decision);
    } else if (decision.action === 'respond_with_image') {
      await handleRespondWithImage(message, channelId, userId, userName, decision, soulConfig);
    } else {
      // Default: respond with text only
      await handleTextResponse(message, channelId, userId, userName, soulConfig);
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

/**
 * Standard text-only response.
 */
async function handleTextResponse(message, channelId, userId, userName, soulConfig) {
  const response = await apiQueue.enqueue(async () => {
    const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...getContext(channelId),
    ];
    try { await message.channel.sendTyping(); } catch (_) {}
    return Promise.race([
      generateResponse(messages, soulConfig),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), config.apiTimeoutMs)),
    ]);
  });

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
async function handleSearchAndRespond(message, channelId, userId, userName, decision, soulConfig) {
  try { await message.channel.sendTyping(); } catch (_) {}

  let searchResults = '';
  try {
    const results = await searchWeb(decision.search_query);
    searchResults = results.map(r => `**${r.title}**\n${r.url}\n${r.snippet}`).join('\n\n');
    logger.info('Thinking', `Web search: "${decision.search_query}" → ${results.length} results`);
  } catch (err) {
    logger.error('Thinking', 'Web search failed:', err.message);
  }

  const response = await apiQueue.enqueue(async () => {
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
  });

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
}

/**
 * Generate an image only (no text response).
 */
async function handleGenerateImage(message, channelId, userId, userName, decision) {
  if (!canGenerateImage(userId)) {
    await message.channel.send({ embeds: [errorEmbed("You've hit the image generation limit. Try again later.")] }).catch(() => {});
    return;
  }

  try { await message.channel.sendTyping(); } catch (_) {}

  try {
    const imageBuffer = await generateImage(decision.image_prompt);
    recordImageGeneration(userId);

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'generated.png' });
    await message.channel.send({ files: [attachment] });

    addMessage(channelId, 'assistant', `[Generated image: ${decision.image_prompt}]`);
    logMessage(channelId, null, 'LLMHub', 'assistant', `[Image: ${decision.image_prompt}]`);

    // Store memory about image preference
    storeMemory(`User ${userName} requested a visual/image about: ${decision.image_prompt}`, {
      userId, userName, channelId, category: 'preference',
    }).catch(() => {});

  } catch (err) {
    logger.error('ImageGen', 'Error:', err.message);
    await message.channel.send({ embeds: [errorEmbed("Failed to generate the image. Try again.")] }).catch(() => {});
  }
}

/**
 * Generate both a text response and an image.
 */
async function handleRespondWithImage(message, channelId, userId, userName, decision, soulConfig) {
  if (!canGenerateImage(userId)) {
    // Fall back to text-only
    await handleTextResponse(message, channelId, userId, userName, soulConfig);
    return;
  }

  try { await message.channel.sendTyping(); } catch (_) {}

  // Run text and image generation in parallel
  const [response, imageResult] = await Promise.allSettled([
    apiQueue.enqueue(async () => {
      const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
      const messages = [
        { role: 'system', content: systemPrompt },
        ...getContext(channelId),
      ];
      return Promise.race([
        generateResponse(messages, soulConfig),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), config.apiTimeoutMs)),
      ]);
    }),
    generateImage(decision.image_prompt),
  ]);

  // Send text response
  let textSent = false;
  if (response.status === 'fulfilled' && response.value) {
    const outMod = await checkOutput(response.value, channelId);
    if (outMod.safe) {
      addMessage(channelId, 'assistant', response.value);
      logMessage(channelId, null, 'LLMHub', 'assistant', response.value);

      // If we also have an image, attach it to the last text chunk
      if (imageResult.status === 'fulfilled') {
        const parts = splitMessage(response.value);
        // Send all but last
        for (let i = 0; i < parts.length - 1; i++) {
          await message.channel.send(parts[i]);
        }
        // Send last part with image
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

  // If text failed but image succeeded, send image alone
  if (!textSent && imageResult.status === 'fulfilled') {
    recordImageGeneration(userId);
    const attachment = new AttachmentBuilder(imageResult.value, { name: 'generated.png' });
    await message.channel.send({ files: [attachment] });
  }

  // If both failed
  if (response.status === 'rejected' && imageResult.status === 'rejected') {
    throw response.reason || new Error('Both text and image generation failed');
  }

  // Store memory about image preference
  storeMemory(`User ${userName} appreciated a visual response about: ${decision.image_prompt}`, {
    userId, userName, channelId, category: 'preference',
  }).catch(() => {});
}

/**
 * Agent loop response — GPT decides when to use tools (search, image gen, etc.)
 */
async function handleAgentResponse(message, channelId, userId, userName, soulConfig) {
  try { await message.channel.sendTyping(); } catch (_) {}

  // Keep typing indicator alive during agent loop
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    const result = await apiQueue.enqueue(async () => {
      const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
      const contextMessages = getContext(channelId);
      const context = { userId, userName, channelId, generatedImages: [] };

      return Promise.race([
        _agentLoop.run(contextMessages, systemPrompt, context),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), config.agentLoopTimeout || 60000)),
      ]);
    });

    clearInterval(typingInterval);

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

    // Build attachments from generated images
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
      // Send all but last without files
      for (let i = 0; i < parts.length - 1; i++) {
        await message.channel.send(parts[i]);
      }
      // Send last part with any image attachments
      await message.channel.send({
        content: parts[parts.length - 1],
        files: files.length > 0 ? files : undefined,
      });
    } else if (files.length > 0) {
      await message.channel.send({ files });
    }
  } catch (err) {
    clearInterval(typingInterval);
    throw err;
  }
}

module.exports = { handleMessage, setAgentLoop, updateHealth, userNameToId, getStats: () => ({ messageCount, errorCount, globalMsgCount, queueStats: apiQueue.getStats() }) };
