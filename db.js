const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DB_PATH = path.join(__dirname, 'llmhub.db');
const db = new Database(DB_PATH);

// ── Performance pragmas ──
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// ── Tables ──
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

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    embedding BLOB,
    user_id TEXT,
    user_name TEXT,
    channel_id TEXT,
    category TEXT DEFAULT 'fact',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    user_name TEXT,
    display_name TEXT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0,
    topics TEXT DEFAULT '[]',
    personality_notes TEXT DEFAULT '',
    preferences TEXT DEFAULT ''
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_state (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tool_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_name TEXT NOT NULL,
    user_id TEXT,
    channel_id TEXT,
    success BOOLEAN DEFAULT 1,
    execution_time_ms INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversation_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    name TEXT,
    timestamp INTEGER DEFAULT (strftime('%s','now')),
    metadata TEXT
  )
`);

// ── Indexes ──
db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON tool_usage(tool_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_usage_timestamp ON tool_usage(timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_channel ON memories(channel_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_users_last_seen ON user_profiles(last_seen)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_context_channel ON conversation_context(channel_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_context_message_id ON conversation_context(message_id)`);

// ── Context persistence statements ──
const insertContextStmt = db.prepare(
  'INSERT INTO conversation_context (channel_id, message_id, role, content, name, metadata) VALUES (?, ?, ?, ?, ?, ?)'
);
const loadContextStmt = db.prepare(
  'SELECT role, content, name, message_id FROM conversation_context WHERE channel_id = ? ORDER BY id DESC LIMIT ?'
);
const clearContextStmt = db.prepare(
  'DELETE FROM conversation_context WHERE channel_id = ?'
);
const updateContextByMsgIdStmt = db.prepare(
  'UPDATE conversation_context SET content = ? WHERE channel_id = ? AND message_id = ?'
);
const deleteContextByMsgIdStmt = db.prepare(
  'DELETE FROM conversation_context WHERE channel_id = ? AND message_id = ?'
);
const trimContextStmt = db.prepare(
  `DELETE FROM conversation_context WHERE channel_id = ? AND id NOT IN (
    SELECT id FROM conversation_context WHERE channel_id = ? ORDER BY id DESC LIMIT ?
  )`
);

// ── Prepared statements ──
const insertStmt = db.prepare(
  'INSERT INTO conversations (channel_id, user_id, user_name, role, content) VALUES (?, ?, ?, ?, ?)'
);
const recentStmt = db.prepare(
  'SELECT role, content, user_name FROM conversations WHERE channel_id = ? ORDER BY id DESC LIMIT ?'
);
const insertSummaryStmt = db.prepare(
  'INSERT INTO summaries (channel_id, summary, message_range) VALUES (?, ?, ?)'
);
const latestSummaryStmt = db.prepare(
  'SELECT summary FROM summaries WHERE channel_id = ? ORDER BY id DESC LIMIT 1'
);
const insertMemoryStmt = db.prepare(
  'INSERT INTO memories (content, embedding, user_id, user_name, channel_id, category, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const allMemoriesStmt = db.prepare(
  'SELECT id, content, embedding, user_id, user_name, channel_id, category, timestamp, metadata FROM memories'
);
const recentMemoriesStmt = db.prepare(
  `SELECT id, content, embedding, user_id, user_name, channel_id, category, timestamp, metadata
   FROM memories WHERE timestamp >= datetime('now', ?)
   ORDER BY timestamp DESC`
);
const memoryCountStmt = db.prepare('SELECT COUNT(*) as cnt FROM memories');
const pruneMemoriesStmt = db.prepare(
  `DELETE FROM memories WHERE id IN (
    SELECT id FROM memories ORDER BY timestamp ASC LIMIT ?
  )`
);
const upsertProfileStmt = db.prepare(`
  INSERT INTO user_profiles (user_id, user_name, display_name, first_seen, last_seen, message_count)
  VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1)
  ON CONFLICT(user_id) DO UPDATE SET
    user_name = excluded.user_name,
    display_name = excluded.display_name,
    last_seen = CURRENT_TIMESTAMP,
    message_count = message_count + 1
`);
const getProfileStmt = db.prepare('SELECT * FROM user_profiles WHERE user_id = ?');
const updateNotesStmt = db.prepare('UPDATE user_profiles SET personality_notes = ? WHERE user_id = ?');
const updatePrefsStmt = db.prepare('UPDATE user_profiles SET preferences = ? WHERE user_id = ?');
const updateTopicsStmt = db.prepare('UPDATE user_profiles SET topics = ? WHERE user_id = ?');
const getStateStmt = db.prepare('SELECT value FROM bot_state WHERE key = ?');
const setStateStmt = db.prepare(
  'INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

// ── DB size monitoring ──
function checkDbSize() {
  try {
    const stat = fs.statSync(DB_PATH);
    const sizeMb = stat.size / (1024 * 1024);
    if (sizeMb > 100) {
      logger.warn('DB', `Database size ${sizeMb.toFixed(1)}MB exceeds 100MB threshold`);
    }
    return sizeMb;
  } catch (_) { return 0; }
}

// Check on startup and every 30 min
checkDbSize();
setInterval(checkDbSize, 30 * 60 * 1000);

// ── Functions ──
function logMessage(channelId, userId, userName, role, content) {
  insertStmt.run(channelId, userId, userName, role, content);
}

function getRecentMessages(channelId, limit = 20) {
  return recentStmt.all(channelId, limit).reverse();
}

function saveSummary(channelId, summary, messageRange) {
  insertSummaryStmt.run(channelId, summary, messageRange);
}

function getLatestSummary(channelId) {
  const row = latestSummaryStmt.get(channelId);
  return row ? row.summary : null;
}

function insertMemory(content, embedding, userId, userName, channelId, category, metadata) {
  insertMemoryStmt.run(content, embedding, userId, userName, channelId, category, metadata);
}

function getAllMemories() {
  return allMemoriesStmt.all();
}

function getRecentMemories(days = 30) {
  return recentMemoriesStmt.all(`-${days} days`);
}

function getMemoryCount() {
  return memoryCountStmt.get().cnt;
}

function pruneOldMemories(count) {
  return pruneMemoriesStmt.run(count);
}

function upsertUserProfile(userId, userName, displayName) {
  upsertProfileStmt.run(userId, userName, displayName);
}

function getUserProfile(userId) {
  return getProfileStmt.get(userId);
}

function updateUserNotes(userId, notes) {
  updateNotesStmt.run(notes, userId);
}

function updateUserPreferences(userId, prefs) {
  updatePrefsStmt.run(prefs, userId);
}

function updateUserTopics(userId, topics) {
  updateTopicsStmt.run(topics, userId);
}

function getState(key) {
  const row = getStateStmt.get(key);
  return row ? row.value : null;
}

// ── Tool usage ──
const insertToolUsageStmt = db.prepare(
  'INSERT INTO tool_usage (tool_name, user_id, channel_id, success, execution_time_ms) VALUES (?, ?, ?, ?, ?)'
);
const toolStatsStmt = db.prepare(`
  SELECT tool_name, COUNT(*) as total, SUM(success) as successes,
    ROUND(AVG(execution_time_ms)) as avg_time_ms
  FROM tool_usage GROUP BY tool_name ORDER BY total DESC
`);

function logToolUsage(toolName, userId, channelId, success, executionTimeMs) {
  insertToolUsageStmt.run(toolName, userId, channelId, success ? 1 : 0, executionTimeMs || 0);
}

function getToolStats() {
  return toolStatsStmt.all();
}

function setState(key, value) {
  setStateStmt.run(key, String(value));
}

// ── Context persistence functions ──
function insertContext(channelId, messageId, role, content, name, metadata) {
  insertContextStmt.run(channelId, messageId || null, role, typeof content === 'string' ? content : JSON.stringify(content), name || null, metadata || null);
}

function loadContext(channelId, limit = 50) {
  return loadContextStmt.all(channelId, limit).reverse();
}

function clearContext(channelId) {
  clearContextStmt.run(channelId);
}

function updateContextByMsgId(channelId, messageId, newContent) {
  updateContextByMsgIdStmt.run(typeof newContent === 'string' ? newContent : JSON.stringify(newContent), channelId, messageId);
}

function deleteContextByMsgId(channelId, messageId) {
  deleteContextByMsgIdStmt.run(channelId, messageId);
}

function trimContext(channelId, keepCount = 100) {
  trimContextStmt.run(channelId, channelId, keepCount);
}

function getDb() { return db; }

module.exports = {
  logMessage, getRecentMessages,
  saveSummary, getLatestSummary,
  insertMemory, getAllMemories, getRecentMemories, getMemoryCount, pruneOldMemories,
  upsertUserProfile, getUserProfile, updateUserNotes, updateUserPreferences, updateUserTopics,
  getState, setState,
  logToolUsage, getToolStats,
  getDb,
  insertContext, loadContext, clearContext, updateContextByMsgId, deleteContextByMsgId, trimContext,
};
