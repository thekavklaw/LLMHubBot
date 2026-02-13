const OpenAI = require('openai');
const Database = require('better-sqlite3');
const path = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const db = new Database(path.join(__dirname, 'llmhub.db'));

// ── Create moderation_log table ──
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

function isEnabled() {
  return process.env.MODERATION_ENABLED !== 'false';
}

/**
 * Run OpenAI moderation on content.
 * Returns { safe, categories, scores }
 */
async function moderate(content) {
  if (!isEnabled() || !content || content.trim().length < 2) {
    return { safe: true, categories: [], scores: {} };
  }

  try {
    const result = await openai.moderations.create({ input: content });
    const res = result.results[0];

    const flaggedCats = [];
    const scores = {};

    for (const cat of FLAGGED_CATEGORIES) {
      // OpenAI uses category names like "hate", "harassment", "self-harm", "sexual", "violence"
      // and subcategories like "hate/threatening", "self-harm/intent", etc.
      for (const [key, flagged] of Object.entries(res.categories)) {
        if (key.startsWith(cat) && flagged) {
          if (!flaggedCats.includes(cat)) flaggedCats.push(cat);
        }
      }
      for (const [key, score] of Object.entries(res.category_scores)) {
        if (key.startsWith(cat)) {
          scores[key] = score;
        }
      }
    }

    return {
      safe: flaggedCats.length === 0,
      categories: flaggedCats,
      scores,
    };
  } catch (err) {
    console.error('[Moderator] API error:', err.message);
    // Fail open — allow message if moderation API is down
    return { safe: true, categories: [], scores: {} };
  }
}

async function moderateInput(content) {
  return moderate(content);
}

async function moderateOutput(content) {
  return moderate(content);
}

/**
 * Check a Discord message for moderation. Returns { safe, result }.
 * If not safe, logs the event and optionally reacts with ⚠️.
 */
async function checkMessage(message) {
  const result = await moderateInput(message.content);

  if (!result.safe) {
    console.log(`[Moderator] Flagged input from ${message.author.username}: [${result.categories.join(', ')}]`);

    insertLogStmt.run(
      message.author.id,
      message.channel.id,
      message.content.slice(0, 200),
      JSON.stringify(result.categories),
      'blocked_input'
    );

    try {
      await message.react('⚠️');
    } catch (_) {}
  }

  return { safe: result.safe, result };
}

/**
 * Check bot output before sending. Returns { safe, result }.
 */
async function checkOutput(content, channelId) {
  const result = await moderateOutput(content);

  if (!result.safe) {
    console.log(`[Moderator] Flagged output: [${result.categories.join(', ')}]`);

    insertLogStmt.run(
      null,
      channelId,
      content.slice(0, 200),
      JSON.stringify(result.categories),
      'blocked_output'
    );
  }

  return { safe: result.safe, result };
}

module.exports = { moderateInput, moderateOutput, checkMessage, checkOutput };
