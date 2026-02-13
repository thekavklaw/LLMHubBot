const { generateResponse } = require('./openai-client');
const { saveSummary, getLatestSummary } = require('./db');

const WINDOW_SIZE = 20;
const SUMMARY_INTERVAL = 10;

// channelId -> { messages: [], messageCount: number, summary: string }
const contexts = new Map();

function ensureContext(channelId) {
  if (!contexts.has(channelId)) {
    // Load persisted summary from DB
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

  // Summarize every SUMMARY_INTERVAL messages for the main channel
  if (channelId === process.env.GPT_CHANNEL_ID && ctx.messageCount % SUMMARY_INTERVAL === 0) {
    const startMsg = ctx.messageCount - SUMMARY_INTERVAL + 1;
    const range = `${startMsg}-${ctx.messageCount}`;
    updateSummary(channelId, range).catch(err => console.error('[Context] Summary error:', err.message));
  }
}

async function updateSummary(channelId, messageRange) {
  const ctx = ensureContext(channelId);
  const msgs = ctx.messages.map(m => `${m.name || m.role}: ${m.content}`).join('\n');

  const prevSummary = ctx.summary ? `\nPrevious summary: ${ctx.summary}` : '';
  const result = await generateResponse([
    { role: 'system', content: `Summarize this conversation in 2-3 sentences. Focus on topics discussed, key points, and who said what.${prevSummary}` },
    { role: 'user', content: msgs },
  ], { model: 'gpt-4o-mini', maxTokens: 200, temperature: 0.3 });

  ctx.summary = result;
  saveSummary(channelId, result, messageRange || '');
  console.log(`[Context] Summary updated for ${channelId}: ${result.slice(0, 80)}...`);
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

module.exports = { addMessage, getContext, getRecentContextMessages };
