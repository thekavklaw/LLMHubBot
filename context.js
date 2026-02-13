const { generateResponse } = require('./openai-client');

const WINDOW_SIZE = 20;
const SUMMARY_INTERVAL = 10;

// channelId -> { messages: [], messageCount: number, summary: string }
const contexts = new Map();

function ensureContext(channelId) {
  if (!contexts.has(channelId)) {
    contexts.set(channelId, { messages: [], messageCount: 0, summary: '' });
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
    updateSummary(channelId).catch(err => console.error('[Context] Summary error:', err.message));
  }
}

async function updateSummary(channelId) {
  const ctx = ensureContext(channelId);
  const msgs = ctx.messages.map(m => `${m.name || m.role}: ${m.content}`).join('\n');
  const result = await generateResponse([
    { role: 'system', content: 'Summarize this conversation in 2-3 sentences. Focus on topics discussed and key points.' },
    { role: 'user', content: msgs },
  ], { model: 'gpt-4o', maxTokens: 200, temperature: 0.3 });
  ctx.summary = result;
}

function getContext(channelId) {
  const ctx = ensureContext(channelId);
  const result = [];
  if (ctx.summary) {
    result.push({ role: 'system', content: `Previous conversation summary: ${ctx.summary}` });
  }
  return result.concat(ctx.messages);
}

module.exports = { addMessage, getContext };
