const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'llmhub.db'));

db.pragma('journal_mode = WAL');

// ── Original tables ──
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

// ── Phase 3: Memory & Soul tables ──
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

// ── Prepared statements: conversations ──
const insertStmt = db.prepare(
  'INSERT INTO conversations (channel_id, user_id, user_name, role, content) VALUES (?, ?, ?, ?, ?)'
);
const recentStmt = db.prepare(
  'SELECT role, content, user_name FROM conversations WHERE channel_id = ? ORDER BY id DESC LIMIT ?'
);

// ── Prepared statements: summaries ──
const insertSummaryStmt = db.prepare(
  'INSERT INTO summaries (channel_id, summary, message_range) VALUES (?, ?, ?)'
);
const latestSummaryStmt = db.prepare(
  'SELECT summary FROM summaries WHERE channel_id = ? ORDER BY id DESC LIMIT 1'
);

// ── Prepared statements: memories ──
const insertMemoryStmt = db.prepare(
  'INSERT INTO memories (content, embedding, user_id, user_name, channel_id, category, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const allMemoriesStmt = db.prepare(
  'SELECT id, content, embedding, user_id, user_name, channel_id, category, timestamp, metadata FROM memories'
);

// ── Prepared statements: user_profiles ──
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
const updateNotesStmt = db.prepare(
  'UPDATE user_profiles SET personality_notes = ? WHERE user_id = ?'
);
const updatePrefsStmt = db.prepare(
  'UPDATE user_profiles SET preferences = ? WHERE user_id = ?'
);
const updateTopicsStmt = db.prepare(
  'UPDATE user_profiles SET topics = ? WHERE user_id = ?'
);

// ── Prepared statements: bot_state ──
const getStateStmt = db.prepare('SELECT value FROM bot_state WHERE key = ?');
const setStateStmt = db.prepare(
  'INSERT INTO bot_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

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

// Memory functions
function insertMemory(content, embedding, userId, userName, channelId, category, metadata) {
  insertMemoryStmt.run(content, embedding, userId, userName, channelId, category, metadata);
}

function getAllMemories() {
  return allMemoriesStmt.all();
}

// User profile functions
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

// Bot state functions
function getState(key) {
  const row = getStateStmt.get(key);
  return row ? row.value : null;
}

function setState(key, value) {
  setStateStmt.run(key, String(value));
}

module.exports = {
  logMessage, getRecentMessages,
  saveSummary, getLatestSummary,
  insertMemory, getAllMemories,
  upsertUserProfile, getUserProfile, updateUserNotes, updateUserPreferences, updateUserTopics,
  getState, setState,
};
