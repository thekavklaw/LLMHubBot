const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_FILES = 3;

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

function formatTimestamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z/, '');
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

  // File output
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + '\n');
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
