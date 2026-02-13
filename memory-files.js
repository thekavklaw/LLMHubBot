/**
 * @module memory-files
 * @description Markdown-based memory layer. Writes human-readable memory files
 * alongside the SQLite/vector system for debugging and transparency.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const MEMORY_DIR = path.join(__dirname, 'data', 'memory');
const DAILY_DIR = path.join(MEMORY_DIR, 'daily');
const USERS_DIR = path.join(MEMORY_DIR, 'users');
const GUILDS_DIR = path.join(MEMORY_DIR, 'guilds');

// Ensure directories exist
for (const dir of [DAILY_DIR, USERS_DIR, GUILDS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function timeStr() {
  return new Date().toISOString().slice(11, 16);
}

/**
 * Append a timestamped line to today's daily memory file.
 * @param {string} content - The memory content
 * @param {string} category - reflection|fact|preference|interaction
 */
function appendDailyMemory(content, category = 'fact') {
  try {
    const filePath = path.join(DAILY_DIR, `${todayStr()}.md`);
    const exists = fs.existsSync(filePath);
    const header = exists ? '' : `# Daily Memory — ${todayStr()}\n\n`;
    const line = `- **${timeStr()}** [${category}] ${content}\n`;
    fs.appendFileSync(filePath, header + line);
  } catch (err) {
    logger.error('MemoryFiles', 'appendDailyMemory error:', err.message);
  }
}

/**
 * Append a dated line to a user's memory file.
 * @param {string} userId - Discord user ID
 * @param {string} userName - Display name
 * @param {string} content - The memory content
 */
function appendUserMemory(userId, userName, content) {
  try {
    const filePath = path.join(USERS_DIR, `${userId}.md`);
    const exists = fs.existsSync(filePath);
    const header = exists ? '' : `# ${userName}\n\n`;
    const line = `- [${todayStr()}] ${content}\n`;
    fs.appendFileSync(filePath, header + line);
  } catch (err) {
    logger.error('MemoryFiles', 'appendUserMemory error:', err.message);
  }
}

/**
 * Read contents of recent daily memory files.
 * @param {number} days - Number of days to look back
 * @returns {string} Concatenated contents
 */
function readRecentDailyMemory(days = 2) {
  try {
    const results = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const filePath = path.join(DAILY_DIR, `${d.toISOString().slice(0, 10)}.md`);
      if (fs.existsSync(filePath)) {
        results.push(fs.readFileSync(filePath, 'utf-8'));
      }
    }
    return results.join('\n\n');
  } catch (err) {
    logger.error('MemoryFiles', 'readRecentDailyMemory error:', err.message);
    return '';
  }
}

/**
 * Read a user's full memory file.
 * @param {string} userId - Discord user ID
 * @returns {string} File contents or empty string
 */
function readUserMemory(userId) {
  try {
    const filePath = path.join(USERS_DIR, `${userId}.md`);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  } catch (err) {
    logger.error('MemoryFiles', 'readUserMemory error:', err.message);
    return '';
  }
}

/**
 * List all user memory files.
 * @returns {string[]} Array of user IDs with memory files
 */
function getAllUserMemoryFiles() {
  try {
    return fs.readdirSync(USERS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''));
  } catch (err) {
    logger.error('MemoryFiles', 'getAllUserMemoryFiles error:', err.message);
    return [];
  }
}

module.exports = { appendDailyMemory, appendUserMemory, readRecentDailyMemory, readUserMemory, getAllUserMemoryFiles };
