const OpenAI = require('openai');
const Database = require('better-sqlite3');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const openai = new OpenAI({ apiKey: config.openaiApiKey });
const db = new Database(path.join(__dirname, 'llmhub.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS moderation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    channel_id TEXT,
    content_snippet TEXT,
    categories TEXT,
    action TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertLogStmt = db.prepare(
  'INSERT INTO moderation_log (user_id, channel_id, content_snippet, categories, action) VALUES (?, ?, ?, ?, ?)'
);

const FLAGGED_CATEGORIES = ['hate', 'harassment', 'self-harm', 'sexual', 'violence'];

async function moderate(content) {
  if (!config.moderationEnabled || !content || content.trim().length < 2) {
    return { safe: true, categories: [], scores: {} };
  }

  try {
    const result = await openai.moderations.create({ input: content });
    const res = result.results[0];
    const flaggedCats = [];
    const scores = {};

    for (const cat of FLAGGED_CATEGORIES) {
      for (const [key, flagged] of Object.entries(res.categories)) {
        if (key.startsWith(cat) && flagged) {
          if (!flaggedCats.includes(cat)) flaggedCats.push(cat);
        }
      }
      for (const [key, score] of Object.entries(res.category_scores)) {
        if (key.startsWith(cat)) scores[key] = score;
      }
    }

    return { safe: flaggedCats.length === 0, categories: flaggedCats, scores };
  } catch (err) {
    logger.error('Moderator', 'API error:', err);
    return { safe: true, categories: [], scores: {} };
  }
}

async function checkMessage(message) {
  const result = await moderate(message.content);
  if (!result.safe) {
    logger.warn('Moderator', `Flagged input from ${message.author.username}: [${result.categories.join(', ')}]`);
    insertLogStmt.run(message.author.id, message.channel.id, message.content.slice(0, 200), JSON.stringify(result.categories), 'blocked_input');
    try { await message.react('⚠️'); } catch (_) {}
  }
  return { safe: result.safe, result };
}

async function checkOutput(content, channelId) {
  const result = await moderate(content);
  if (!result.safe) {
    logger.warn('Moderator', `Flagged output: [${result.categories.join(', ')}]`);
    insertLogStmt.run(null, channelId, content.slice(0, 200), JSON.stringify(result.categories), 'blocked_output');
  }
  return { safe: result.safe, result };
}

module.exports = { moderateInput: moderate, moderateOutput: moderate, checkMessage, checkOutput };
