const assert = require('assert');
const path = require('path');
const fs = require('fs');

let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`❌ ${name}: ${err.message}`);
  }
}

(async () => {
  console.log('=== LLMHub Bot Test Suite ===\n');

  // ──────────── CONFIG TESTS ────────────
  const config = require('../config');

  await test('config: exports frozen object', () => {
    assert.ok(typeof config === 'object');
    assert.ok(Object.isFrozen(config), 'Config should be frozen');
  });

  await test('config: all required keys present', () => {
    const required = ['gptChannelId', 'model', 'miniModel', 'temperature', 'maxTokens',
      'rateLimitUser', 'rateLimitVip', 'rateLimitWindow', 'maxConcurrentApi', 'apiTimeoutMs',
      'memoryMaxRows', 'contextWindowSize', 'dbBusyTimeout', 'logLevel'];
    for (const key of required) {
      assert.ok(config[key] !== undefined, `Missing config key: ${key}`);
    }
  });

  await test('config: defaults are sensible', () => {
    assert.strictEqual(config.maxConcurrentApi, 10);
    assert.strictEqual(config.apiTimeoutMs, 30000);
    assert.strictEqual(config.rateLimitGlobalPerMinute, 60);
    assert.strictEqual(config.memoryMaxRows, 10000);
    assert.ok(config.temperature > 0 && config.temperature <= 2);
  });

  await test('config: features object exists', () => {
    assert.ok(config.features);
    assert.strictEqual(typeof config.features.memory, 'boolean');
    assert.strictEqual(typeof config.features.moderation, 'boolean');
  });

  // ──────────── LOGGER TESTS ────────────
  const logger = require('../logger');

  await test('logger: exports all level functions', () => {
    assert.strictEqual(typeof logger.debug, 'function');
    assert.strictEqual(typeof logger.info, 'function');
    assert.strictEqual(typeof logger.warn, 'function');
    assert.strictEqual(typeof logger.error, 'function');
  });

  await test('logger: formatTimestamp returns valid format', () => {
    const ts = logger.formatTimestamp();
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts), `Bad format: ${ts}`);
  });

  await test('logger: setLevel works', () => {
    logger.setLevel('debug');
    logger.setLevel('info'); // Reset
  });

  await test('logger: LEVELS object correct', () => {
    assert.strictEqual(logger.LEVELS.debug, 0);
    assert.strictEqual(logger.LEVELS.error, 3);
  });

  // ──────────── QUEUE TESTS ────────────
  const TaskQueue = require('../queue');

  await test('queue: processes tasks', async () => {
    const q = new TaskQueue(2);
    const results = [];
    await Promise.all([
      q.enqueue(async () => { results.push(1); return 1; }),
      q.enqueue(async () => { results.push(2); return 2; }),
      q.enqueue(async () => { results.push(3); return 3; }),
    ]);
    assert.deepStrictEqual(results.sort(), [1, 2, 3]);
  });

  await test('queue: respects concurrency limit', async () => {
    const q = new TaskQueue(2);
    let maxConcurrent = 0;
    let current = 0;

    const task = () => q.enqueue(async () => {
      current++;
      if (current > maxConcurrent) maxConcurrent = current;
      await new Promise(r => setTimeout(r, 50));
      current--;
    });

    await Promise.all([task(), task(), task(), task(), task()]);
    assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, expected <=2`);
  });

  await test('queue: getStats returns correct shape', () => {
    const q = new TaskQueue(5);
    const stats = q.getStats();
    assert.strictEqual(typeof stats.queued, 'number');
    assert.strictEqual(typeof stats.processing, 'number');
    assert.strictEqual(typeof stats.completed, 'number');
    assert.strictEqual(typeof stats.errors, 'number');
  });

  await test('queue: tracks errors', async () => {
    const q = new TaskQueue(2);
    try {
      await q.enqueue(async () => { throw new Error('test error'); });
    } catch (_) {}
    assert.strictEqual(q.getStats().errors, 1);
  });

  await test('queue: tasks complete in order', async () => {
    const q = new TaskQueue(1); // Sequential
    const order = [];
    await q.enqueue(async () => order.push('a'));
    await q.enqueue(async () => order.push('b'));
    await q.enqueue(async () => order.push('c'));
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
  });

  // ──────────── DB TESTS ────────────
  const db = require('../db');

  await test('db: logMessage + getRecentMessages', () => {
    const ch = 'test-ch-' + Date.now();
    db.logMessage(ch, 'u1', 'TestUser', 'user', 'Hello world');
    db.logMessage(ch, 'bot', 'LLMHub', 'assistant', 'Hi there');
    const msgs = db.getRecentMessages(ch, 10);
    assert.ok(msgs.length >= 2);
    assert.strictEqual(msgs[msgs.length - 1].content, 'Hi there');
  });

  await test('db: saveSummary + getLatestSummary', () => {
    const ch = 'test-summary-' + Date.now();
    assert.strictEqual(db.getLatestSummary(ch), null);
    db.saveSummary(ch, 'Test summary', '1-10');
    assert.strictEqual(db.getLatestSummary(ch), 'Test summary');
  });

  await test('db: upsertUserProfile + getUserProfile', () => {
    const uid = 'test-user-' + Date.now();
    db.upsertUserProfile(uid, 'testname', 'TestDisplay');
    const p = db.getUserProfile(uid);
    assert.ok(p);
    assert.strictEqual(p.user_name, 'testname');
    assert.strictEqual(p.message_count, 1);
  });

  await test('db: updateUserNotes', () => {
    const uid = 'test-notes-' + Date.now();
    db.upsertUserProfile(uid, 'noteuser', 'NoteUser');
    db.updateUserNotes(uid, 'Likes cats');
    const p = db.getUserProfile(uid);
    assert.strictEqual(p.personality_notes, 'Likes cats');
  });

  await test('db: insertMemory + getAllMemories', () => {
    const before = db.getAllMemories().length;
    db.insertMemory('test memory', null, 'u1', 'TestUser', 'ch1', 'fact', null);
    assert.strictEqual(db.getAllMemories().length, before + 1);
  });

  await test('db: getState + setState', () => {
    const key = 'test-key-' + Date.now();
    assert.strictEqual(db.getState(key), null);
    db.setState(key, 'hello');
    assert.strictEqual(db.getState(key), 'hello');
  });

  await test('db: getMemoryCount returns number', () => {
    const count = db.getMemoryCount();
    assert.strictEqual(typeof count, 'number');
    assert.ok(count >= 0);
  });

  await test('db: getRecentMemories returns array', () => {
    const mems = db.getRecentMemories(30);
    assert.ok(Array.isArray(mems));
  });

  await test('db: all required tables exist', () => {
    const Database = require('better-sqlite3');
    const dbFile = new Database(path.join(__dirname, '..', 'llmhub.db'), { readonly: true });
    const tables = dbFile.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    dbFile.close();
    for (const t of ['conversations', 'summaries', 'memories', 'user_profiles', 'bot_state', 'moderation_log']) {
      assert.ok(tables.includes(t), `Missing table: ${t}`);
    }
  });

  await test('db: indexes exist', () => {
    const Database = require('better-sqlite3');
    const dbFile = new Database(path.join(__dirname, '..', 'llmhub.db'), { readonly: true });
    const indexes = dbFile.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name);
    dbFile.close();
    for (const idx of ['idx_memories_channel', 'idx_memories_timestamp', 'idx_users_last_seen']) {
      assert.ok(indexes.includes(idx), `Missing index: ${idx}`);
    }
  });

  // ──────────── SOUL TESTS ────────────
  const soul = require('../soul');

  await test('soul: getSoulConfig returns valid config', () => {
    const cfg = soul.getSoulConfig();
    assert.ok(cfg.model);
    assert.strictEqual(typeof cfg.temperature, 'number');
    assert.strictEqual(cfg.name, 'LLMHub');
  });

  await test('soul: getSystemPrompt is async function', () => {
    assert.strictEqual(typeof soul.getSystemPrompt, 'function');
  });

  // ──────────── CONTEXT TESTS ────────────
  const context = require('../context');

  await test('context: addMessage + getContext', () => {
    const ch = 'ctx-test-' + Date.now();
    context.addMessage(ch, 'user', 'Hello', 'TestUser');
    const ctx = context.getContext(ch);
    assert.ok(ctx.length >= 1);
    assert.strictEqual(ctx[ctx.length - 1].content, 'Hello');
  });

  await test('context: window caps at configured size', () => {
    const ch = 'ctx-cap-' + Date.now();
    for (let i = 0; i < 25; i++) context.addMessage(ch, 'user', `msg-${i}`, 'User');
    const ctx = context.getContext(ch);
    const userMsgs = ctx.filter(m => m.role === 'user');
    assert.ok(userMsgs.length <= 20);
  });

  await test('context: getRecentContextMessages works', () => {
    const ch = 'ctx-recent-' + Date.now();
    context.addMessage(ch, 'user', 'test1', 'U');
    assert.ok(context.getRecentContextMessages(ch).length >= 1);
  });

  await test('context: withChannelLock exported', () => {
    assert.strictEqual(typeof context.withChannelLock, 'function');
  });

  // ──────────── RATELIMITER TESTS ────────────
  const { checkRateLimit, trackGlobalApiCall } = require('../ratelimiter');

  await test('ratelimiter: allows messages under limit', () => {
    const uid = 'rl-user-' + Date.now();
    const ch = 'rl-ch-' + Date.now();
    for (let i = 0; i < 5; i++) {
      const r = checkRateLimit(uid, ch, false);
      assert.ok(r.allowed, `Message ${i + 1} should be allowed`);
    }
  });

  await test('ratelimiter: blocks at limit', () => {
    const uid = 'rl-block-' + Date.now();
    const ch = 'rl-blkch-' + Date.now();
    for (let i = 0; i < 5; i++) checkRateLimit(uid, ch, false);
    const r = checkRateLimit(uid, ch, false);
    assert.strictEqual(r.allowed, false);
    assert.ok(r.retryAfter > 0);
  });

  await test('ratelimiter: thread limit is higher', () => {
    const uid = 'rl-thread-' + Date.now();
    const ch = 'rl-thrch-' + Date.now();
    let allowed = 0;
    for (let i = 0; i < 12; i++) {
      const r = checkRateLimit(uid, ch, true);
      if (r.allowed) allowed++;
    }
    assert.ok(allowed >= 10, `Expected at least 10 allowed in thread, got ${allowed}`);
  });

  await test('ratelimiter: trackGlobalApiCall works', () => {
    assert.strictEqual(typeof trackGlobalApiCall, 'function');
    const result = trackGlobalApiCall();
    assert.strictEqual(typeof result, 'boolean');
  });

  // ──────────── USERS TESTS ────────────
  const users = require('../users');

  await test('users: trackUser creates profile', () => {
    const uid = 'usr-track-' + Date.now();
    users.trackUser(uid, 'tracker', 'Tracker');
    const p = users.getProfile(uid);
    assert.ok(p);
    assert.strictEqual(p.user_name, 'tracker');
  });

  await test('users: appendUserNotes appends', () => {
    const uid = 'usr-notes-' + Date.now();
    users.trackUser(uid, 'noter', 'Noter');
    users.appendUserNotes(uid, 'Likes Python');
    users.appendUserNotes(uid, 'Plays guitar');
    const p = users.getProfile(uid);
    assert.ok(p.personality_notes.includes('Likes Python'));
    assert.ok(p.personality_notes.includes('Plays guitar'));
  });

  await test('users: deduplicates notes', () => {
    const uid = 'usr-dedup-' + Date.now();
    users.trackUser(uid, 'dedup', 'Dedup');
    users.appendUserNotes(uid, 'Same note');
    users.appendUserNotes(uid, 'Same note');
    const p = users.getProfile(uid);
    assert.strictEqual((p.personality_notes.match(/Same note/g) || []).length, 1);
  });

  await test('users: formatProfileForPrompt returns string', () => {
    const uid = 'usr-fmt-' + Date.now();
    users.trackUser(uid, 'fmtuser', 'FmtUser');
    const result = users.formatProfileForPrompt(uid);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('FmtUser'));
  });

  await test('users: profile caching works', () => {
    const uid = 'usr-cache-' + Date.now();
    users.trackUser(uid, 'cached', 'Cached');
    const p1 = users.getProfile(uid);
    const p2 = users.getProfile(uid); // Should come from cache
    assert.deepStrictEqual(p1, p2);
  });

  // ──────────── MEMORY TESTS ────────────
  const { LRUCache } = require('../memory');

  await test('memory: LRU cache basic operations', () => {
    const cache = new LRUCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    assert.strictEqual(cache.get('a'), 1);
    assert.strictEqual(cache.size, 3);
  });

  await test('memory: LRU cache evicts oldest', () => {
    const cache = new LRUCache(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // Should evict 'a'
    assert.strictEqual(cache.get('a'), undefined);
    assert.strictEqual(cache.get('b'), 2);
    assert.strictEqual(cache.get('c'), 3);
  });

  // ──────────── MODERATOR TESTS ────────────
  const moderator = require('../moderator');

  await test('moderator: exports all functions', () => {
    assert.strictEqual(typeof moderator.checkMessage, 'function');
    assert.strictEqual(typeof moderator.checkOutput, 'function');
    assert.strictEqual(typeof moderator.moderateInput, 'function');
    assert.strictEqual(typeof moderator.moderateOutput, 'function');
  });

  // ──────────── FILE CHECKS ────────────
  const expectedFiles = ['index.js', 'db.js', 'context.js', 'soul.js', 'users.js', 'moderator.js',
    'memory.js', 'openai-client.js', 'relevance.js', 'threads.js', 'config.js', 'logger.js', 'queue.js'];

  await test('all source files exist and have content', () => {
    for (const f of expectedFiles) {
      const fp = path.join(__dirname, '..', f);
      assert.ok(fs.existsSync(fp), `Missing: ${f}`);
      assert.ok(fs.statSync(fp).size > 0, `Empty: ${f}`);
    }
  });

  await test('handler files exist', () => {
    const handlers = ['handlers/messageHandler.js', 'handlers/interactionHandler.js'];
    for (const f of handlers) {
      const fp = path.join(__dirname, '..', f);
      assert.ok(fs.existsSync(fp), `Missing: ${f}`);
    }
  });

  await test('soul.md data file exists', () => {
    const fp = path.join(__dirname, '..', 'data', 'soul.md');
    assert.ok(fs.existsSync(fp));
    assert.ok(fs.readFileSync(fp, 'utf-8').includes('LLMHub'));
  });

  // ──────────── RESULTS ────────────
  console.log('\n' + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);
})();
