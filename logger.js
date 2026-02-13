/**
 * @module logger
 * @description Structured logging with file rotation. Supports debug/info/warn/error
 * levels and writes to both console and data/bot.log with automatic rotation.
 * Uses async file writes and enforces max total log size (50MB).
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5MB per file
const MAX_FILES = 3;
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total across all rotated files

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] || LEVELS.info;

fs.mkdirSync(LOG_DIR, { recursive: true });

function setLevel(level) {
  if (LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_SIZE) return;
    // Rotate: bot.log.2 -> delete, bot.log.1 -> bot.log.2, bot.log -> bot.log.1
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const src = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
      const dst = `${LOG_FILE}.${i}`;
      try { fs.renameSync(src, dst); } catch (_) {}
    }
  } catch (_) {
    // File doesn't exist yet
  }
}

/** Enforce max total log size by deleting oldest rotated files */
function enforceTotalSize() {
  try {
    let totalSize = 0;
    const files = [];
    // Check main log + rotated
    for (let i = 0; i <= MAX_FILES; i++) {
      const f = i === 0 ? LOG_FILE : `${LOG_FILE}.${i}`;
      try {
        const stat = fs.statSync(f);
        totalSize += stat.size;
        files.push({ path: f, index: i, size: stat.size });
      } catch (_) {}
    }
    if (totalSize > MAX_TOTAL_SIZE) {
      // Delete from oldest (highest index)
      for (let i = files.length - 1; i >= 0 && totalSize > MAX_TOTAL_SIZE; i--) {
        try {
          fs.unlinkSync(files[i].path);
          totalSize -= files[i].size;
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// Check total size periodically (every 10 minutes)
setInterval(enforceTotalSize, 10 * 60 * 1000);

function formatTimestamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
}

// Write buffer for async file writes
let writeQueue = [];
let writing = false;

async function flushWrites() {
  if (writing || writeQueue.length === 0) return;
  writing = true;
  const lines = writeQueue.splice(0, writeQueue.length);
  try {
    fs.appendFile(LOG_FILE, lines.join(''), () => {});
  } catch (_) {}
  writing = false;
}

function log(level, module, message, ...args) {
  if (LEVELS[level] === undefined || LEVELS[level] < currentLevel) return;

  const extra = args.length > 0 ? ' ' + args.map(a =>
    a instanceof Error ? a.stack || a.message : typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' ') : '';

  const line = `[${formatTimestamp()}] [${level.toUpperCase()}] [${module}] ${message}${extra}`;

  // Console output
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  // Async file output
  try {
    rotateIfNeeded();
    writeQueue.push(line + '\n');
    setImmediate(flushWrites);
  } catch (_) {}
}

const logger = {
  debug: (module, msg, ...args) => log('debug', module, msg, ...args),
  info: (module, msg, ...args) => log('info', module, msg, ...args),
  warn: (module, msg, ...args) => log('warn', module, msg, ...args),
  error: (module, msg, ...args) => log('error', module, msg, ...args),
  setLevel,
  LEVELS,
  formatTimestamp,
};

module.exports = logger;
