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

db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    verbosity TEXT DEFAULT 'normal',
    images_enabled BOOLEAN DEFAULT 1,
    updated_at INTEGER
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    user_id TEXT,
    channel_id TEXT,
    reaction TEXT,
    timestamp INTEGER
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_feedback_message ON feedback(message_id)`);

// ── Indexes ──
db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON tool_usage(tool_name)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_usage_timestamp ON tool_usage(timestamp)`);
// Add guild_id column if not present (Phase 1 migration)
try {
  db.exec(`ALTER TABLE memories ADD COLUMN guild_id TEXT`);
  logger.info('DB', 'Added guild_id column to memories table');
} catch (_) {} // Column already exists

// Phase 2 migrations: tier, significance, consolidated columns
try { db.exec(`ALTER TABLE memories ADD COLUMN tier TEXT DEFAULT 'observation'`); logger.info('DB', 'Added tier column'); } catch (_) {}
try { db.exec(`ALTER TABLE memories ADD COLUMN significance REAL DEFAULT 0.5`); logger.info('DB', 'Added significance column'); } catch (_) {}
try { db.exec(`ALTER TABLE memories ADD COLUMN consolidated INTEGER DEFAULT 0`); logger.info('DB', 'Added consolidated column'); } catch (_) {}

// Phase 3 migrations: memory decay, soft-delete
try { db.exec(`ALTER TABLE memories ADD COLUMN last_accessed INTEGER DEFAULT 0`); logger.info('DB', 'Added last_accessed column'); } catch (_) {}
try { db.exec(`ALTER TABLE memories ADD COLUMN reinforcement_count INTEGER DEFAULT 0`); logger.info('DB', 'Added reinforcement_count column'); } catch (_) {}
try { db.exec(`ALTER TABLE memories ADD COLUMN forgotten INTEGER DEFAULT 0`); logger.info('DB', 'Added forgotten column'); } catch (_) {}

db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_guild ON memories(guild_id)`);

// FTS5 virtual table for hybrid search
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, category, user_name, guild_id, content_rowid=rowid)`);

// Populate FTS5 from existing memories (idempotent — only inserts missing rows)
try {
  const ftsCount = db.prepare('SELECT COUNT(*) as cnt FROM memory_fts').get().cnt;
  const memCount = db.prepare('SELECT COUNT(*) as cnt FROM memories').get().cnt;
  if (ftsCount < memCount) {
    const missing = db.prepare(`SELECT id, content, category, user_name, guild_id FROM memories WHERE id NOT IN (SELECT rowid FROM memory_fts)`).all();
    const insertFts = db.prepare('INSERT INTO memory_fts(rowid, content, category, user_name, guild_id) VALUES (?, ?, ?, ?, ?)');
    const batch = db.transaction((rows) => { for (const r of rows) insertFts.run(r.id, r.content, r.category, r.user_name, r.guild_id); });
    batch(missing);
    logger.info('DB', `Synced ${missing.length} memories to FTS5`);
  }
} catch (err) { logger.error('DB', 'FTS5 sync error:', err.message); }

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
  'INSERT INTO memories (content, embedding, user_id, user_name, channel_id, category, metadata, guild_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const allMemoriesStmt = db.prepare(
  'SELECT id, content, embedding, user_id, user_name, channel_id, category, timestamp, metadata FROM memories'
);
const recentMemoriesStmt = db.prepare(
  `SELECT id, content, embedding, user_id, user_name, channel_id, category, timestamp, metadata, last_accessed, reinforcement_count
   FROM memories WHERE timestamp >= datetime('now', ?) AND forgotten = 0
   ORDER BY timestamp DESC`
);
const recentMemoriesLimitedStmt = db.prepare(
  `SELECT id, content, embedding, user_id, user_name, channel_id, category, timestamp, metadata, last_accessed, reinforcement_count
   FROM memories WHERE timestamp >= datetime('now', ?) AND forgotten = 0
   ORDER BY timestamp DESC LIMIT ?`
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

const insertFtsStmt = db.prepare('INSERT INTO memory_fts(rowid, content, category, user_name, guild_id) VALUES (?, ?, ?, ?, ?)');
const searchFtsStmt = db.prepare(`SELECT rowid, rank, content, category, user_name, guild_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?`);
const getMemoriesByUserStmt = db.prepare(`SELECT id, content, category, timestamp, significance, tier, consolidated FROM memories WHERE user_id = ? ORDER BY timestamp DESC`);
const markConsolidatedStmt = db.prepare(`UPDATE memories SET consolidated = 1 WHERE id = ?`);
const countUserMemoriesStmt = db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE user_id = ? AND consolidated = 0`);

function insertMemory(content, embedding, userId, userName, channelId, category, metadata, guildId, tier, significance) {
  const info = db.prepare(
    'INSERT INTO memories (content, embedding, user_id, user_name, channel_id, category, metadata, guild_id, tier, significance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(content, embedding, userId, userName, channelId, category, metadata, guildId || null, tier || 'observation', significance ?? 0.5);
  // Sync to FTS5
  try { insertFtsStmt.run(info.lastInsertRowid, content, category, userName, guildId || null); } catch (_) {}
  return info.lastInsertRowid;
}

function searchFts(query, limit = 10) {
  try {
    // Sanitize: remove FTS5 special chars
    const sanitized = query.replace(/['"*(){}[\]:^~!@#$%&\\]/g, ' ').trim();
    if (!sanitized) return [];
    // Wrap words in quotes for safe matching
    const terms = sanitized.split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' ');
    return searchFtsStmt.all(terms, limit);
  } catch (err) {
    logger.error('DB', 'FTS5 search error:', err.message);
    return [];
  }
}

function getMemoriesByUser(userId) {
  return getMemoriesByUserStmt.all(userId);
}

function markMemoryConsolidated(memoryId) {
  markConsolidatedStmt.run(memoryId);
}

function countUserUnconsolidatedMemories(userId) {
  return countUserMemoriesStmt.get(userId).cnt;
}

function getAllMemories() {
  return allMemoriesStmt.all();
}

function getRecentMemories(days = 30, limit = null) {
  if (limit) return recentMemoriesLimitedStmt.all(`-${days} days`, limit);
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

// ── User settings ──
const getUserSettingsStmt = db.prepare('SELECT * FROM user_settings WHERE user_id = ?');
const upsertUserSettingsStmt = db.prepare(`
  INSERT INTO user_settings (user_id, verbosity, images_enabled, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    verbosity = excluded.verbosity,
    images_enabled = excluded.images_enabled,
    updated_at = excluded.updated_at
`);

/**
 * Get user settings from SQLite.
 * @param {string} userId - Discord user ID
 * @returns {Object|null} User settings row or null
 */
function getUserSettings(userId) {
  return getUserSettingsStmt.get(userId) || null;
}

/**
 * Save user settings to SQLite.
 * @param {string} userId - Discord user ID
 * @param {string} verbosity - 'concise', 'normal', or 'detailed'
 * @param {boolean} imagesEnabled - Whether image generation is enabled
 */
function saveUserSettings(userId, verbosity, imagesEnabled) {
  upsertUserSettingsStmt.run(userId, verbosity, imagesEnabled ? 1 : 0, Date.now());
}

// ── Feedback ──
const insertFeedbackStmt = db.prepare(
  'INSERT INTO feedback (message_id, user_id, channel_id, reaction, timestamp) VALUES (?, ?, ?, ?, ?)'
);
const feedbackStatsStmt = db.prepare('SELECT reaction, COUNT(*) as count FROM feedback GROUP BY reaction');
const messageCountStmt = db.prepare('SELECT COUNT(*) as count FROM conversations');

function insertFeedback(messageId, userId, channelId, reaction, timestamp) {
  insertFeedbackStmt.run(messageId, userId, channelId, reaction, timestamp);
}

function getFeedbackStats() {
  return feedbackStatsStmt.all();
}

function getMessageCount() {
  return messageCountStmt.get();
}

// ── Phase 3: Memory command helpers ──
const getUserMemoriesStmt = db.prepare(
  `SELECT id, content, category, timestamp, significance, tier, consolidated
   FROM memories WHERE user_id = ? AND forgotten = 0 ORDER BY tier DESC, timestamp DESC`
);
const softDeleteMemoryStmt = db.prepare('UPDATE memories SET forgotten = 1 WHERE id = ?');
const deleteFtsRowStmt = db.prepare('DELETE FROM memory_fts WHERE rowid = ?');
const touchMemoryStmt = db.prepare('UPDATE memories SET last_accessed = ?, reinforcement_count = reinforcement_count + 1 WHERE id = ?');
const searchUserMemoriesByTopicStmt = db.prepare(
  `SELECT m.id, m.content, m.category, m.timestamp FROM memories m
   INNER JOIN memory_fts f ON f.rowid = m.id
   WHERE m.user_id = ? AND m.forgotten = 0 AND memory_fts MATCH ?
   ORDER BY f.rank LIMIT 20`
);

function getUserMemoriesActive(userId) {
  return getUserMemoriesStmt.all(userId);
}

function softDeleteMemory(memoryId) {
  softDeleteMemoryStmt.run(memoryId);
  try { deleteFtsRowStmt.run(memoryId); } catch (_) {}
}

function touchMemory(memoryId) {
  touchMemoryStmt.run(Date.now(), memoryId);
}

function searchUserMemoriesByTopic(userId, topic) {
  try {
    const sanitized = topic.replace(/['"*(){}[\]:^~!@#$%&\\]/g, ' ').trim();
    if (!sanitized) return [];
    const terms = sanitized.split(/\s+/).filter(Boolean).map(t => `"${t}"`).join(' ');
    return searchUserMemoriesByTopicStmt.all(userId, terms);
  } catch (err) {
    logger.error('DB', 'searchUserMemoriesByTopic error:', err.message);
    return [];
  }
}

function getDb() { return db; }
function close() { try { db.close(); } catch (_) {} }

module.exports = {
  close,
  logMessage, getRecentMessages,
  saveSummary, getLatestSummary,
  insertMemory, getAllMemories, getRecentMemories, getMemoryCount, pruneOldMemories, searchFts, getMemoriesByUser, markMemoryConsolidated, countUserUnconsolidatedMemories, getUserMemoriesActive, softDeleteMemory, touchMemory, searchUserMemoriesByTopic,
  upsertUserProfile, getUserProfile, updateUserNotes, updateUserPreferences, updateUserTopics,
  getState, setState,
  logToolUsage, getToolStats,
  getDb,
  insertContext, loadContext, clearContext, updateContextByMsgId, deleteContextByMsgId, trimContext,
  getUserSettings, saveUserSettings,
  insertFeedback, getFeedbackStats, getMessageCount,
};
