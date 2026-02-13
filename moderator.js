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

const FLAGGED_CATEGORIES = ['hate', 'harassment', 'self-harm', 'sexual', 'violence', 'illicit', 'illicit/violent'];

/**
 * Moderate content using omni-moderation-latest (supports text + images).
 * @param {string} content - text content
 * @param {string[]} imageUrls - optional image URLs
 */
async function moderate(content, imageUrls = []) {
  if (!config.moderationEnabled) {
    return { safe: true, categories: [], scores: {} };
  }
  if ((!content || content.trim().length < 2) && imageUrls.length === 0) {
    return { safe: true, categories: [], scores: {} };
  }

  try {
    // Build multi-modal input for omni-moderation
    const input = [];
    if (content && content.trim().length >= 2) {
      input.push({ type: 'text', text: content });
    }
    for (const url of imageUrls) {
      input.push({ type: 'image_url', image_url: { url } });
    }

    logger.debug('Moderator', `API call: text=${content ? content.length : 0} chars, images=${imageUrls.length}`);
    const result = await openai.moderations.create({
      model: 'omni-moderation-latest',
      input: input.length === 1 && input[0].type === 'text' ? content : input,
    });

    const res = result.results[0];
    const flaggedCats = [];
    const scores = {};

    for (const cat of FLAGGED_CATEGORIES) {
      for (const [key, flagged] of Object.entries(res.categories)) {
        if (key === cat || key.startsWith(cat + '/')) {
          if (flagged && !flaggedCats.includes(cat)) flaggedCats.push(cat);
        }
      }
      for (const [key, score] of Object.entries(res.category_scores)) {
        if (key === cat || key.startsWith(cat + '/')) scores[key] = score;
      }
    }

    const safe = flaggedCats.length === 0;
    if (!safe) {
      logger.warn('Moderator', `Content flagged — categories: [${flaggedCats.join(', ')}], scores: ${JSON.stringify(scores)}`);
    }
    logger.debug('Moderator', `Moderation result: safe=${safe}, categories=[${flaggedCats.join(', ')}]`);
    return { safe, categories: flaggedCats, scores };
  } catch (err) {
    logger.error('Moderator', 'API error:', { error: err.message, stack: err.stack });
    return { safe: true, categories: [], scores: {} };
  }
}

async function checkMessage(message, imageUrls = []) {
  const result = await moderate(message.content, imageUrls);
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
