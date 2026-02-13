const { generateResponse } = require('./openai-client');
const { countMessagesTokens } = require('./tokenizer');
const { saveSummary, getLatestSummary } = require('./db');
const config = require('./config');
const logger = require('./logger');

const MAX_CONTEXT_TOKENS = 6000;
const SUMMARIZE_OLDEST_PERCENT = 0.6;

// channelId -> { messages, messageCount, summary }
const contexts = new Map();

// Per-channel locks
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
  ctx.messages.push({
    role,
    content,
    name: userName ? userName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) : undefined,
  });
  ctx.messageCount++;

  // Trigger token budget check (non-blocking)
  checkTokenBudget(channelId).catch(err => logger.error('Context', 'Token budget error:', err));
}

/**
 * Check if context exceeds token budget. If so, summarize oldest 60%.
 */
async function checkTokenBudget(channelId) {
  const ctx = ensureContext(channelId);
  if (ctx.messages.length < 4) return; // not enough to summarize

  const tokens = countMessagesTokens(ctx.messages);
  if (tokens <= MAX_CONTEXT_TOKENS) return;

  logger.info('Context', `Token budget exceeded for ${channelId}: ${tokens} > ${MAX_CONTEXT_TOKENS}. Summarizing...`);

  const splitIdx = Math.ceil(ctx.messages.length * SUMMARIZE_OLDEST_PERCENT);
  const oldMessages = ctx.messages.slice(0, splitIdx);
  const keepMessages = ctx.messages.slice(splitIdx);

  // Build text to summarize
  const oldText = oldMessages.map(m => `${m.name || m.role}: ${typeof m.content === 'string' ? m.content : '[media]'}`).join('\n');
  const prevSummary = ctx.summary ? `\nPrevious conversation summary: ${ctx.summary}` : '';

  try {
    const summary = await generateResponse([
      { role: 'system', content: `Summarize this conversation concisely in 2-3 sentences. Include key topics, decisions, and who said what.${prevSummary}` },
      { role: 'user', content: oldText },
    ], { model: config.miniModel || 'gpt-4.1-mini', maxTokens: 300, temperature: 0.3, tools: false });

    ctx.summary = summary;
    ctx.messages = keepMessages;
    const range = `${ctx.messageCount - oldMessages.length}-${ctx.messageCount}`;
    saveSummary(channelId, summary, range);
    logger.info('Context', `Summarized ${oldMessages.length} messages → ${summary.slice(0, 80)}...`);
  } catch (err) {
    logger.error('Context', 'Summarization failed:', err);
  }
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
