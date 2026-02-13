const { generateResponse } = require('./openai-client');
const { saveSummary, getLatestSummary } = require('./db');
const config = require('./config');
const logger = require('./logger');

const WINDOW_SIZE = config.contextWindowSize;
const SUMMARY_INTERVAL = config.summaryInterval;

// channelId -> { messages, messageCount, summary }
const contexts = new Map();

// Per-channel locks for context updates
const channelLocks = new Map();

async function withChannelLock(channelId, fn) {
  while (channelLocks.get(channelId)) {
    await new Promise(r => setTimeout(r, 10));
  }
  channelLocks.set(channelId, true);
  try {
    return await fn();
  } finally {
    channelLocks.set(channelId, false);
  }
}

function ensureContext(channelId) {
  if (!contexts.has(channelId)) {
    const dbSummary = getLatestSummary(channelId);
    contexts.set(channelId, { messages: [], messageCount: 0, summary: dbSummary || '' });
  }
  return contexts.get(channelId);
}

function addMessage(channelId, role, content, userName) {
  const ctx = ensureContext(channelId);
  ctx.messages.push({ role, content, name: userName ? userName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) : undefined });
  if (ctx.messages.length > WINDOW_SIZE) {
    ctx.messages = ctx.messages.slice(-WINDOW_SIZE);
  }
  ctx.messageCount++;

  // Non-blocking summary generation
  if (channelId === config.gptChannelId && ctx.messageCount % SUMMARY_INTERVAL === 0) {
    const range = `${ctx.messageCount - SUMMARY_INTERVAL + 1}-${ctx.messageCount}`;
    updateSummary(channelId, range).catch(err => logger.error('Context', 'Summary error:', err));
  }
}

async function updateSummary(channelId, messageRange) {
  const ctx = ensureContext(channelId);
  const msgs = ctx.messages.map(m => `${m.name || m.role}: ${m.content}`).join('\n');
  const prevSummary = ctx.summary ? `\nPrevious summary: ${ctx.summary}` : '';

  const result = await generateResponse([
    { role: 'system', content: `Summarize this conversation in 2-3 sentences. Focus on topics discussed, key points, and who said what.${prevSummary}` },
    { role: 'user', content: msgs },
  ], { model: config.miniModel, maxTokens: 200, temperature: 0.3 });

  ctx.summary = result;
  saveSummary(channelId, result, messageRange || '');
  logger.info('Context', `Summary updated for ${channelId}: ${result.slice(0, 80)}...`);
}

function getContext(channelId) {
  const ctx = ensureContext(channelId);
  const result = [];
  if (ctx.summary) {
    result.push({ role: 'system', content: `Previous conversation summary: ${ctx.summary}` });
  }
  return result.concat(ctx.messages);
}

function getRecentContextMessages(channelId) {
  const ctx = ensureContext(channelId);
  return ctx.messages;
}

module.exports = { addMessage, getContext, getRecentContextMessages, withChannelLock };
