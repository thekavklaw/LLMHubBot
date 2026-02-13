/**
 * @module context
 * @description Manages per-channel conversation context with SQLite persistence,
 * automatic token budget management, and context summarization.
 */

const { generateResponse } = require('./openai-client');
const { countMessagesTokens } = require('./tokenizer');
const { saveSummary, getLatestSummary, insertContext, loadContext, clearContext: clearContextDb, updateContextByMsgId, deleteContextByMsgId, trimContext } = require('./db');
const config = require('./config');
const logger = require('./logger');

const MAX_CONTEXT_TOKENS = 12000;
const SUMMARIZE_OLDEST_PERCENT = 0.6;
const MAX_CONTEXT_MESSAGES = 100; // max messages to keep in SQLite per channel
const MAX_CACHED_CHANNELS = 100;

// channelId -> { messages, messageCount, summary, loaded, lastAccess }
const contexts = new Map();

/** Evict least recently used channels if over limit */
function evictIfNeeded() {
  if (contexts.size <= MAX_CACHED_CHANNELS) return;
  const entries = [...contexts.entries()].sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
  const toEvict = entries.slice(0, contexts.size - MAX_CACHED_CHANNELS);
  for (const [key] of toEvict) {
    contexts.delete(key);
    channelLocks.delete(key);
  }
  if (toEvict.length > 0) logger.info('Context', `Evicted ${toEvict.length} stale channels from cache`);
}

// ── Per-channel mutex (promise-chain lock) ──
const channelLocks = new Map();

async function withChannelLock(channelId, fn) {
  if (!channelLocks.has(channelId)) channelLocks.set(channelId, Promise.resolve());
  const prev = channelLocks.get(channelId);
  let resolve;
  const next = new Promise(r => { resolve = r; });
  channelLocks.set(channelId, next);
  try {
    await Promise.race([
      prev,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Channel lock timeout')), 90000)),
    ]);
  } catch (err) {
    logger.warn('Context', `Lock timeout for channel ${channelId}, proceeding anyway`);
  }
  try {
    return await fn();
  } finally {
    resolve();
    // Clean up resolved lock
    if (channelLocks.get(channelId) === next) {
      channelLocks.delete(channelId);
    }
  }
}

function ensureContext(channelId) {
  if (!contexts.has(channelId)) {
    // Lazy-load from SQLite on first access
    const dbSummary = getLatestSummary(channelId);
    const dbMessages = loadContext(channelId, MAX_CONTEXT_MESSAGES);
    const messages = dbMessages.map(row => ({
      role: row.role,
      content: tryParseJson(row.content),
      name: row.name || undefined,
      messageId: row.message_id || undefined,
    }));
    contexts.set(channelId, { messages, messageCount: messages.length, summary: dbSummary || '', loaded: true, lastAccess: Date.now() });
    evictIfNeeded();
    if (messages.length > 0) {
      logger.info('Context', `Lazy-loaded ${messages.length} messages for channel ${channelId}`);
    }
  }
  const ctx = contexts.get(channelId);
  ctx.lastAccess = Date.now();
  return ctx;
}

function tryParseJson(str) {
  if (!str || !str.startsWith('[') && !str.startsWith('{')) return str;
  try { return JSON.parse(str); } catch { return str; }
}

function addMessage(channelId, role, content, userName, messageId) {
  return withChannelLock(channelId, async () => {
    const ctx = ensureContext(channelId);
    const msg = {
      role,
      content,
      name: userName ? userName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) : undefined,
      messageId: messageId || undefined,
    };
    ctx.messages.push(msg);
    ctx.messageCount++;

    // Write-through to SQLite
    try {
      insertContext(channelId, messageId || null, role, content, msg.name);
      // Trim old messages in SQLite periodically
      if (ctx.messageCount % 50 === 0) {
        trimContext(channelId, MAX_CONTEXT_MESSAGES);
      }
    } catch (err) {
      logger.error('Context', `SQLite write error: ${err.message}`);
    }

    // Check token budget inside the lock
    await checkTokenBudget(channelId);
  });
}

/**
 * Update a message in context by Discord message ID (for edits).
 */
function updateMessage(channelId, messageId, newContent) {
  return withChannelLock(channelId, async () => {
    const ctx = ensureContext(channelId);
    const idx = ctx.messages.findIndex(m => m.messageId === messageId);
    if (idx !== -1) {
      ctx.messages[idx].content = newContent;
      logger.info('Context', `Updated message ${messageId} in channel ${channelId}`);
    }
    try {
      updateContextByMsgId(channelId, messageId, newContent);
    } catch (err) {
      logger.error('Context', `SQLite update error: ${err.message}`);
    }
  });
}

/**
 * Delete a message from context by Discord message ID.
 */
function deleteMessage(channelId, messageId) {
  return withChannelLock(channelId, async () => {
    const ctx = ensureContext(channelId);
    const idx = ctx.messages.findIndex(m => m.messageId === messageId);
    if (idx !== -1) {
      ctx.messages.splice(idx, 1);
      logger.info('Context', `Deleted message ${messageId} from channel ${channelId}`);
    }
    try {
      deleteContextByMsgId(channelId, messageId);
    } catch (err) {
      logger.error('Context', `SQLite delete error: ${err.message}`);
    }
  });
}

/**
 * Check if context exceeds token budget. If so, summarize oldest 60%.
 */
async function checkTokenBudget(channelId) {
  const ctx = ensureContext(channelId);
  if (ctx.messages.length < 4) return;

  const tokens = countMessagesTokens(ctx.messages);
  if (tokens <= MAX_CONTEXT_TOKENS) return;

  logger.info('Context', `Token budget exceeded for ${channelId}: ${tokens} > ${MAX_CONTEXT_TOKENS}. Summarizing...`);

  const splitIdx = Math.ceil(ctx.messages.length * SUMMARIZE_OLDEST_PERCENT);
  const oldMessages = ctx.messages.slice(0, splitIdx);
  const keepMessages = ctx.messages.slice(splitIdx);

  const oldText = oldMessages.map(m => `${m.name || m.role}: ${typeof m.content === 'string' ? m.content : '[media]'}`).join('\n');
  const prevSummary = ctx.summary ? `\nPrevious conversation summary: ${ctx.summary}` : '';

  try {
    const summary = await generateResponse([
      { role: 'system', content: `Summarize this conversation concisely in 2-3 sentences. IMPORTANT: Preserve key facts, specific user names, and any decisions or preferences mentioned. Include a "highlights" note if anything particularly notable happened (e.g., user asked for help, shared a preference, a tool was used).${prevSummary}` },
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
  // Strip internal fields before returning
  return result.concat(ctx.messages.map(m => ({
    role: m.role,
    content: m.content,
    ...(m.name ? { name: m.name } : {}),
  })));
}

function getRecentContextMessages(channelId) {
  const ctx = ensureContext(channelId);
  return ctx.messages;
}

function clearChannelContext(channelId) {
  return withChannelLock(channelId, async () => {
    contexts.delete(channelId);
    try {
      clearContextDb(channelId);
    } catch (err) {
      logger.error('Context', `SQLite clear error: ${err.message}`);
    }
    logger.info('Context', `Cleared context for channel ${channelId}`);
  });
}

module.exports = { addMessage, getContext, getRecentContextMessages, withChannelLock, updateMessage, deleteMessage, clearChannelContext };
