const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'llmhub.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    user_id TEXT,
    user_name TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    message_range TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const insertSummaryStmt = db.prepare(
  'INSERT INTO summaries (channel_id, summary, message_range) VALUES (?, ?, ?)'
);

const latestSummaryStmt = db.prepare(
  'SELECT summary FROM summaries WHERE channel_id = ? ORDER BY id DESC LIMIT 1'
);

function saveSummary(channelId, summary, messageRange) {
  insertSummaryStmt.run(channelId, summary, messageRange);
}

function getLatestSummary(channelId) {
  const row = latestSummaryStmt.get(channelId);
  return row ? row.summary : null;
}

const insertStmt = db.prepare(
  'INSERT INTO conversations (channel_id, user_id, user_name, role, content) VALUES (?, ?, ?, ?, ?)'
);

const recentStmt = db.prepare(
  'SELECT role, content, user_name FROM conversations WHERE channel_id = ? ORDER BY id DESC LIMIT ?'
);

function logMessage(channelId, userId, userName, role, content) {
  insertStmt.run(channelId, userId, userName, role, content);
}

function getRecentMessages(channelId, limit = 20) {
  return recentStmt.all(channelId, limit).reverse();
}

module.exports = { logMessage, getRecentMessages, saveSummary, getLatestSummary };
