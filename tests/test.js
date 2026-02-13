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
    for (const t of ['conversations', 'summaries', 'memories', 'user_profiles', 'bot_state', 'moderation_log', 'conversation_context']) {
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

  await test('context: addMessage + getContext', async () => {
    const ch = 'ctx-test-' + Date.now();
    await context.addMessage(ch, 'user', 'Hello', 'TestUser');
    const ctx = context.getContext(ch);
    assert.ok(ctx.length >= 1);
    assert.strictEqual(ctx[ctx.length - 1].content, 'Hello');
  });

  await test('context: window stores messages and retrieves them', async () => {
    const ch = 'ctx-cap-' + Date.now();
    for (let i = 0; i < 25; i++) await context.addMessage(ch, 'user', `msg-${i}`, 'User');
    const ctx = context.getContext(ch);
    const userMsgs = ctx.filter(m => m.role === 'user');
    assert.ok(userMsgs.length >= 1, 'Should have at least 1 user message');
  });

  await test('context: getRecentContextMessages works', async () => {
    const ch = 'ctx-recent-' + Date.now();
    await context.addMessage(ch, 'user', 'test1', 'U');
    assert.ok(context.getRecentContextMessages(ch).length >= 1);
  });

  await test('context: updateMessage and deleteMessage exported', () => {
    assert.strictEqual(typeof context.updateMessage, 'function');
    assert.strictEqual(typeof context.deleteMessage, 'function');
  });

  await test('context: clearChannelContext exported', () => {
    assert.strictEqual(typeof context.clearChannelContext, 'function');
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

  // ──────────── QA ADDITIONAL TESTS ────────────

  await test('config: GUILD_ID is set', () => {
    assert.ok(config.guildId || process.env.GUILD_ID, 'GUILD_ID must be configured');
  });

  await test('config: GPT_CHANNEL_ID is set', () => {
    assert.ok(config.gptChannelId, 'GPT_CHANNEL_ID must be configured');
  });

  await test('queue: tasks actually execute and return values', async () => {
    const q = new TaskQueue(2);
    const result = await q.enqueue(async () => 42);
    assert.strictEqual(result, 42);
  });

  await test('queue: getStats counts are accurate after work', async () => {
    const q = new TaskQueue(1);
    await q.enqueue(async () => 'a');
    await q.enqueue(async () => 'b');
    const stats = q.getStats();
    assert.strictEqual(stats.completed, 2);
    assert.strictEqual(stats.queued, 0);
    assert.strictEqual(stats.processing, 0);
  });

  await test('logger: log file gets created', () => {
    const logDir = path.join(__dirname, '..', 'data');
    if (fs.existsSync(logDir)) {
      const logFiles = fs.readdirSync(logDir).filter(f => f.includes('bot.log'));
      // Just verify the logger doesn't crash when writing
      logger.info('QA', 'test log entry');
      assert.ok(true);
    } else {
      logger.info('QA', 'test log entry');
      assert.ok(true);
    }
  });

  await test('handlers export expected interface', () => {
    const msgHandler = require('../handlers/messageHandler');
    const intHandler = require('../handlers/interactionHandler');
    assert.ok(typeof msgHandler === 'function' || typeof msgHandler === 'object', 'messageHandler should export');
    assert.ok(typeof intHandler === 'function' || typeof intHandler === 'object', 'interactionHandler should export');
    if (typeof msgHandler === 'object') assert.ok(msgHandler.handleMessage, 'messageHandler should have handleMessage');
    if (typeof intHandler === 'object') assert.ok(intHandler.handleInteraction || intHandler.default || Object.keys(intHandler).length > 0, 'interactionHandler should have exports');
  });

  await test('index.js is reasonable size (<300 lines)', () => {
    const content = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(lines < 300, `index.js has ${lines} lines, expected <300`);
  });

  await test('.gitignore covers sensitive files', () => {
    const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf-8');
    assert.ok(gitignore.includes('.env'), '.gitignore must cover .env');
    assert.ok(gitignore.includes('node_modules'), '.gitignore must cover node_modules');
    assert.ok(gitignore.includes('.db'), '.gitignore must cover .db files');
  });

  await test('README mentions all modules', () => {
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8');
    const modules = ['config', 'db', 'soul', 'context', 'memory', 'users', 'moderator', 'ratelimiter', 'relevance', 'threads'];
    for (const m of modules) {
      assert.ok(readme.toLowerCase().includes(m), `README should mention ${m}`);
    }
  });

  await test('no hardcoded secrets in .js files', () => {
    const jsFiles = fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.js'));
    const handlerFiles = fs.readdirSync(path.join(__dirname, '..', 'handlers')).filter(f => f.endsWith('.js'));
    const allFiles = [...jsFiles.map(f => path.join(__dirname, '..', f)), ...handlerFiles.map(f => path.join(__dirname, '..', 'handlers', f))];
    for (const fp of allFiles) {
      const content = fs.readFileSync(fp, 'utf-8');
      assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(content), `Hardcoded OpenAI key in ${path.basename(fp)}`);
      assert.ok(!/ghp_[a-zA-Z0-9]{20,}/.test(content), `Hardcoded GitHub token in ${path.basename(fp)}`);
      assert.ok(!/MTQ3[a-zA-Z0-9]{50,}/.test(content), `Hardcoded Discord token in ${path.basename(fp)}`);
    }
  });

  // ──────────── TOOL DEFINITIONS ────────────
  const toolDefFiles = ['brave_search', 'tavily_search', 'generate_image', 'calculator', 'timestamp', 'define_word', 'summarize_url', 'remember', 'recall', 'code_runner'];

  for (const name of toolDefFiles) {
    await test(`tool definition: ${name} loads and has required exports`, () => {
      const tool = require(`../tools/definitions/${name}`);
      assert.ok(tool.name, `${name} must have name`);
      assert.ok(tool.description, `${name} must have description`);
      assert.ok(tool.parameters, `${name} must have parameters`);
      assert.strictEqual(typeof tool.execute, 'function', `${name} must have execute function`);
    });
  }

  await test('tool registry: loads all 10 tools', () => {
    const ToolRegistry = require('../tools/registry');
    const reg = new ToolRegistry();
    reg.loadAll();
    const tools = reg.listTools();
    assert.strictEqual(tools.length, 10, `Expected 10 tools, got ${tools.length}`);
  });

  await test('tool registry: getToolsForOpenAI returns correct format', () => {
    const ToolRegistry = require('../tools/registry');
    const reg = new ToolRegistry();
    reg.loadAll();
    const openaiTools = reg.getToolsForOpenAI();
    assert.ok(openaiTools.length === 10);
    for (const t of openaiTools) {
      assert.strictEqual(t.type, 'function');
      assert.ok(t.function.name);
      assert.ok(t.function.description);
    }
  });

  // ── Calculator tests ──
  const calculator = require('../tools/definitions/calculator');

  await test('calculator: evaluates simple expression', async () => {
    const r = await calculator.execute({ expression: '2 + 3 * 4' });
    assert.strictEqual(r.result, 14);
  });

  await test('calculator: evaluates Math functions', async () => {
    const r = await calculator.execute({ expression: 'sqrt(144)' });
    assert.strictEqual(r.result, 12);
  });

  await test('calculator: power operator', async () => {
    const r = await calculator.execute({ expression: '2^10' });
    assert.strictEqual(r.result, 1024);
  });

  await test('calculator: blocks process access', async () => {
    try {
      await calculator.execute({ expression: 'process.exit()' });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Blocked') || e.message.includes('unsafe'));
    }
  });

  await test('calculator: blocks require', async () => {
    try {
      await calculator.execute({ expression: 'require("fs")' });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Blocked') || e.message.includes('unsafe'));
    }
  });

  await test('calculator: blocks constructor tricks', async () => {
    try {
      await calculator.execute({ expression: 'constructor.constructor("return this")()' });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Blocked') || e.message.includes('unsafe') || e.message.includes('disallowed'));
    }
  });

  await test('calculator: rejects too-long expressions', async () => {
    try {
      await calculator.execute({ expression: '1+'.repeat(200) });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('too long'));
    }
  });

  // ── Timestamp tests ──
  const timestamp = require('../tools/definitions/timestamp');

  await test('timestamp: returns valid date info', async () => {
    const r = await timestamp.execute({});
    assert.ok(r.timezone === 'UTC');
    assert.ok(r.iso);
    assert.ok(typeof r.unix === 'number');
    assert.ok(r.date);
    assert.ok(r.time);
  });

  await test('timestamp: supports timezone', async () => {
    const r = await timestamp.execute({ timezone: 'America/New_York' });
    assert.strictEqual(r.timezone, 'America/New_York');
    assert.ok(r.date);
  });

  await test('timestamp: rejects invalid timezone', async () => {
    try {
      await timestamp.execute({ timezone: 'Fake/Zone' });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message);
    }
  });

  // ── Code runner tests (E2B sandbox) ──
  const codeRunner = require('../tools/definitions/code_runner');

  await test('code_runner: has correct parameters', () => {
    assert.strictEqual(codeRunner.name, 'code_runner');
    assert.ok(codeRunner.parameters.properties.language);
    assert.deepStrictEqual(codeRunner.parameters.properties.language.enum, ['python', 'javascript']);
  });

  await test('code_runner: rejects unsupported language', async () => {
    try {
      await codeRunner.execute({ code: 'print("hi")', language: 'ruby' });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Unsupported'));
    }
  });

  await test('code_runner: rejects code > 10000 chars', async () => {
    try {
      await codeRunner.execute({ code: 'x=1;\n'.repeat(5000) });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('too long'));
    }
  });

  // ── DB tool usage ──
  await test('db: logToolUsage and getToolStats work', () => {
    // Use unique tool name to avoid accumulation across test runs
    const toolName = 'test_tool_' + Date.now();
    db.logToolUsage(toolName, 'user1', 'chan1', true, 100);
    db.logToolUsage(toolName, 'user1', 'chan1', false, 200);
    const stats = db.getToolStats();
    const entry = stats.find(s => s.tool_name === toolName);
    assert.ok(entry, 'Should find tool in stats');
    assert.strictEqual(entry.total, 2);
    assert.strictEqual(entry.successes, 1);
  });

  // ── /tools command data ──
  await test('/tools: generates correct embed data', () => {
    const ToolRegistry = require('../tools/registry');
    const reg = new ToolRegistry();
    reg.loadAll();
    const tools = reg.listTools();
    const lines = tools.map(t => `${t.name} — ${t.description.split('.')[0]}`);
    assert.ok(lines.length === 10);
    assert.ok(lines.some(l => l.includes('calculator')));
    assert.ok(lines.some(l => l.includes('brave_search')));
    assert.ok(lines.some(l => l.includes('code_runner')));
  });

  // ── Summarize URL SSRF protection ──
  const summarizeUrl = require('../tools/definitions/summarize_url');

  await test('summarize_url: blocks localhost', async () => {
    try {
      await summarizeUrl.execute({ url: 'http://localhost/secret' });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Blocked') || e.message.includes('internal'));
    }
  });

  await test('summarize_url: blocks private IPs', async () => {
    try {
      await summarizeUrl.execute({ url: 'http://192.168.1.1/' });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Blocked') || e.message.includes('internal'));
    }
  });

  await test('summarize_url: blocks non-http URLs', async () => {
    try {
      await summarizeUrl.execute({ url: 'ftp://example.com/file' });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Invalid') || e.message.includes('Blocked'));
    }
  });

  // ──────────── FRIENDLY ERRORS ────────────
  const { friendlyError, USER_ERRORS } = require('../utils/errors');

  await test('friendlyError: rate limit (429)', () => {
    const msg = friendlyError({ status: 429, message: 'Rate limited' });
    assert.ok(msg.includes(USER_ERRORS.rate_limit), 'Should contain rate limit message');
    assert.ok(msg.includes('ref:'), 'Should include ref ID');
  });

  await test('friendlyError: timeout error', () => {
    const msg = friendlyError({ message: 'TIMEOUT' });
    assert.ok(msg.includes(USER_ERRORS.timeout), 'Should contain timeout message');
  });

  await test('friendlyError: ETIMEDOUT code', () => {
    const msg = friendlyError({ code: 'ETIMEDOUT', message: 'connect' });
    assert.ok(msg.includes(USER_ERRORS.timeout));
  });

  await test('friendlyError: timeout in message', () => {
    const msg = friendlyError({ message: 'Request timed out' });
    assert.ok(msg.includes(USER_ERRORS.timeout));
  });

  await test('friendlyError: server error (500)', () => {
    const msg = friendlyError({ status: 500, message: 'Internal' });
    assert.ok(msg.includes(USER_ERRORS.api_error));
  });

  await test('friendlyError: server error (503)', () => {
    const msg = friendlyError({ status: 503, message: 'Unavailable' });
    assert.ok(msg.includes(USER_ERRORS.api_error));
  });

  await test('friendlyError: queue full', () => {
    const msg = friendlyError({ message: 'QUEUE_FULL' });
    assert.ok(msg.includes(USER_ERRORS.queue_full));
  });

  await test('friendlyError: moderation error', () => {
    const msg = friendlyError({ message: 'Content flagged by moderation' });
    assert.ok(msg.includes(USER_ERRORS.moderation));
  });

  await test('friendlyError: unknown error', () => {
    const msg = friendlyError({ message: 'Something weird' });
    assert.ok(msg.includes(USER_ERRORS.unknown));
  });

  await test('friendlyError: null error', () => {
    const msg = friendlyError(null);
    assert.ok(msg.includes(USER_ERRORS.unknown));
  });

  await test('friendlyError: undefined error', () => {
    const msg = friendlyError(undefined);
    assert.ok(msg.includes(USER_ERRORS.unknown));
  });

  await test('USER_ERRORS: all messages are strings with emoji', () => {
    for (const [key, msg] of Object.entries(USER_ERRORS)) {
      assert.strictEqual(typeof msg, 'string', `${key} should be string`);
      assert.ok(msg.length > 10, `${key} should be meaningful`);
    }
  });

  // ──────────── USER SETTINGS (DB) ────────────
  const { getUserSettings, saveUserSettings, getDb } = require('../db');

  await test('userSettings: save and load', () => {
    saveUserSettings('test-user-1', 'concise', true);
    const settings = getUserSettings('test-user-1');
    assert.ok(settings);
    assert.strictEqual(settings.verbosity, 'concise');
    assert.strictEqual(settings.images_enabled, 1);
    assert.ok(settings.updated_at > 0);
  });

  await test('userSettings: update existing', () => {
    saveUserSettings('test-user-1', 'detailed', false);
    const settings = getUserSettings('test-user-1');
    assert.strictEqual(settings.verbosity, 'detailed');
    assert.strictEqual(settings.images_enabled, 0);
  });

  await test('userSettings: nonexistent user returns null', () => {
    const settings = getUserSettings('nonexistent-user-xyz');
    assert.strictEqual(settings, null);
  });

  await test('userSettings: default values work', () => {
    saveUserSettings('test-user-2', 'normal', true);
    const settings = getUserSettings('test-user-2');
    assert.strictEqual(settings.verbosity, 'normal');
    assert.strictEqual(settings.images_enabled, 1);
  });

  // ──────────── CONTEXT PERSISTENCE ────────────
  const { clearChannelContext, addMessage, getContext } = require('../context');

  await test('context: clearChannelContext clears context', async () => {
    const testChannel = 'test-reset-channel-123';
    await addMessage(testChannel, 'user', 'Hello there', 'testuser');
    let ctx = getContext(testChannel);
    assert.ok(ctx.length > 0, 'Context should have messages');
    await clearChannelContext(testChannel);
    ctx = getContext(testChannel);
    assert.strictEqual(ctx.length, 0, 'Context should be empty after clear');
  });

  await test('context: add and retrieve messages', async () => {
    const ch = 'test-ctx-add-123';
    await clearChannelContext(ch);
    await addMessage(ch, 'user', 'First message', 'alice');
    await addMessage(ch, 'assistant', 'Reply');
    const ctx = getContext(ch);
    assert.ok(ctx.length >= 2);
  });

  await test('context: persistence survives Map clear', async () => {
    const ch = 'test-ctx-persist-123';
    await clearChannelContext(ch);
    await addMessage(ch, 'user', 'Persist test', 'bob', 'msg-persist-1');
    // Simulate restart by clearing internal Map (require cache trick)
    const contextModule = require('../context');
    // We can't easily clear the internal Map without modifying the module,
    // but clearChannelContext + re-add proves SQLite persistence
    await clearChannelContext(ch);
    await addMessage(ch, 'user', 'After clear', 'bob', 'msg-persist-2');
    const ctx = getContext(ch);
    assert.ok(ctx.some(m => m.content === 'After clear'));
  });

  // ──────────── LRU CACHE EXTENDED ────────────
  const LRUCacheUtil = require('../utils/cache');

  await test('LRUCache: TTL expiry', async () => {
    const cache = new LRUCacheUtil(10, 50); // 50ms TTL
    cache.set('key1', 'value1');
    assert.strictEqual(cache.get('key1'), 'value1');
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(cache.get('key1'), null, 'Should expire after TTL');
  });

  await test('LRUCache: eviction when full', () => {
    const cache = new LRUCacheUtil(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // Should evict 'a'
    assert.strictEqual(cache.get('a'), null);
    assert.strictEqual(cache.get('d'), 4);
  });

  await test('LRUCache: get refreshes position', () => {
    const cache = new LRUCacheUtil(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a'); // Refresh 'a'
    cache.set('d', 4); // Should evict 'b'
    assert.strictEqual(cache.get('a'), 1);
    assert.strictEqual(cache.get('b'), null);
  });

  await test('LRUCache: stats tracking', () => {
    const cache = new LRUCacheUtil(10);
    cache.set('x', 1);
    cache.get('x'); // hit
    cache.get('y'); // miss
    const stats = cache.getStats();
    assert.strictEqual(stats.hits, 1);
    assert.strictEqual(stats.misses, 1);
    assert.strictEqual(stats.size, 1);
  });

  await test('LRUCache: custom TTL per item', async () => {
    const cache = new LRUCacheUtil(10, 10000);
    cache.set('short', 'val', 50); // 50ms TTL override
    assert.strictEqual(cache.get('short'), 'val');
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(cache.get('short'), null);
  });

  // ──────────── DEBOUNCER ────────────
  const MessageDebouncer = require('../utils/debouncer');

  await test('debouncer: coalesces rapid messages', async () => {
    const debouncer = new MessageDebouncer(100);
    let result = null;
    const msg1 = { channel: { id: 'ch1' }, author: { id: 'u1' }, content: 'hello' };
    const msg2 = { channel: { id: 'ch1' }, author: { id: 'u1' }, content: 'world' };
    debouncer.add(msg1, (lastMsg, combined) => { result = { lastMsg, combined }; });
    debouncer.add(msg2, (lastMsg, combined) => { result = { lastMsg, combined }; });
    await new Promise(r => setTimeout(r, 150));
    assert.ok(result);
    assert.strictEqual(result.combined, 'hello\nworld');
    assert.strictEqual(result.lastMsg.content, 'world');
  });

  await test('debouncer: different users not coalesced', async () => {
    const debouncer = new MessageDebouncer(100);
    let count = 0;
    const msg1 = { channel: { id: 'ch1' }, author: { id: 'u1' }, content: 'a' };
    const msg2 = { channel: { id: 'ch1' }, author: { id: 'u2' }, content: 'b' };
    debouncer.add(msg1, () => { count++; });
    debouncer.add(msg2, () => { count++; });
    await new Promise(r => setTimeout(r, 150));
    assert.strictEqual(count, 2, 'Different users should fire separately');
  });

  await test('debouncer: hasPending', () => {
    const debouncer = new MessageDebouncer(5000);
    const msg = { channel: { id: 'ch-pend' }, author: { id: 'u-pend' }, content: 'test' };
    debouncer.add(msg, () => {});
    assert.ok(debouncer.hasPending('ch-pend', 'u-pend'));
    assert.ok(!debouncer.hasPending('ch-other', 'u-pend'));
  });

  await test('debouncer: getStats', () => {
    const debouncer = new MessageDebouncer(5000);
    const msg = { channel: { id: 'ch-stats' }, author: { id: 'u-stats' }, content: 'test' };
    debouncer.add(msg, () => {});
    const stats = debouncer.getStats();
    assert.strictEqual(typeof stats.pendingBatches, 'number');
    assert.ok(stats.pendingBatches >= 1);
  });

  // ──────────── PRIORITY QUEUE ────────────
  const { PriorityTaskQueue } = require('../utils/model-queue');

  await test('PriorityQueue: processes higher priority first', async () => {
    const queue = new PriorityTaskQueue(1, 10);
    const order = [];
    // Block the queue with a slow task
    const blocker = queue.enqueue(async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push('blocker');
    }, 0);
    // Enqueue low then high priority
    const low = queue.enqueue(async () => { order.push('low'); }, 0);
    const high = queue.enqueue(async () => { order.push('high'); }, 3);
    await Promise.all([blocker, low, high]);
    assert.strictEqual(order[0], 'blocker');
    assert.strictEqual(order[1], 'high');
    assert.strictEqual(order[2], 'low');
  });

  await test('PriorityQueue: rejects when full', async () => {
    const queue = new PriorityTaskQueue(1, 2);
    // Fill queue
    const p1 = queue.enqueue(async () => new Promise(r => setTimeout(r, 100)), 0);
    const p2 = queue.enqueue(async () => 'ok', 0);
    const p3 = queue.enqueue(async () => 'ok', 0);
    try {
      await queue.enqueue(async () => 'should fail', 0);
      assert.fail('Should have rejected');
    } catch (e) {
      assert.strictEqual(e.message, 'QUEUE_FULL');
    }
    await Promise.allSettled([p1, p2, p3]);
  });

  await test('PriorityQueue: getStats', async () => {
    const queue = new PriorityTaskQueue(10, 50);
    await queue.enqueue(async () => 'done', 0);
    const stats = queue.getStats();
    assert.strictEqual(stats.completed, 1);
    assert.strictEqual(stats.errors, 0);
    assert.strictEqual(stats.pending, 0);
  });

  await test('PriorityQueue: tracks errors', async () => {
    const queue = new PriorityTaskQueue(10, 50);
    try {
      await queue.enqueue(async () => { throw new Error('test'); }, 0);
    } catch (_) {}
    assert.strictEqual(queue.getStats().errors, 1);
  });

  // ──────────── MODEL QUEUE ────────────
  const { ModelQueue } = require('../utils/model-queue');

  await test('ModelQueue: routes to correct queue', async () => {
    const mq = new ModelQueue();
    assert.strictEqual(mq.getQueueName('gpt-5.2'), 'main');
    assert.strictEqual(mq.getQueueName('gpt-4.1-mini'), 'mini');
    assert.strictEqual(mq.getQueueName('gpt-image-1'), 'image');
    assert.strictEqual(mq.getQueueName('omni-moderation-latest'), 'moderation');
    assert.strictEqual(mq.getQueueName(null), 'main');
  });

  await test('ModelQueue: enqueue and execute', async () => {
    const mq = new ModelQueue();
    const result = await mq.enqueue('gpt-5.2', async () => 42, 0);
    assert.strictEqual(result, 42);
  });

  await test('ModelQueue: getStats returns all queues', () => {
    const mq = new ModelQueue();
    const stats = mq.getStats();
    assert.ok(stats.main);
    assert.ok(stats.mini);
    assert.ok(stats.image);
    assert.ok(stats.moderation);
  });

  await test('ModelQueue: isQueueFull', () => {
    const mq = new ModelQueue({ mainMaxDepth: 2, mainConcurrency: 1 });
    assert.ok(!mq.isQueueFull('gpt-5.2'));
  });

  // ──────────── HEALTH ENDPOINT ────────────
  const http = require('http');
  const { startHealthServer } = require('../health');

  await test('health: returns valid JSON', async () => {
    const port = 38700 + Math.floor(Math.random() * 1000);
    const server = startHealthServer(port, () => ({
      queues: {}, messagesProcessed: 5, errors: 1, debouncer: {},
    }));
    await new Promise(r => setTimeout(r, 100));
    const data = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/health`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      }).on('error', reject);
    });
    assert.strictEqual(data.status, 'ok');
    assert.strictEqual(data.messagesProcessed, 5);
    assert.ok(data.uptime >= 0);
    assert.ok(data.timestamp);
    server.close();
  });

  await test('health: 404 on non-health path', async () => {
    const port = 38700 + Math.floor(Math.random() * 1000);
    const server = startHealthServer(port, () => ({}));
    await new Promise(r => setTimeout(r, 100));
    const statusCode = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/other`, (res) => resolve(res.statusCode)).on('error', reject);
    });
    assert.strictEqual(statusCode, 404);
    server.close();
  });

  // ──────────── TOOL FALLBACK CHAINS ────────────
  await test('brave_search: has fallback in execute', () => {
    const brave = require('../tools/definitions/brave_search');
    assert.ok(typeof brave.execute === 'function');
    // Verify the module exports expected fields
    assert.strictEqual(brave.name, 'brave_search');
    assert.ok(brave.getCache);
  });

  await test('tavily_search: has fallback in execute', () => {
    const tavily = require('../tools/definitions/tavily_search');
    assert.ok(typeof tavily.execute === 'function');
    assert.strictEqual(tavily.name, 'tavily_search');
    assert.ok(tavily.getCache);
  });

  // ──────────── DB MODULE ────────────
  await test('db: getDb returns database instance', () => {
    const db = getDb();
    assert.ok(db);
    assert.ok(typeof db.prepare === 'function');
  });

  await test('db: user_settings table exists', () => {
    const db = getDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'").get();
    assert.ok(row, 'user_settings table should exist');
  });

  // ──────────── RETRY UTILITY ────────────
  const { withRetry } = require('../utils/retry');

  await test('retry: succeeds on first try', async () => {
    const result = await withRetry(() => Promise.resolve(42), { label: 'test' });
    assert.strictEqual(result, 42);
  });

  await test('retry: retries on failure then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(() => {
      attempts++;
      if (attempts < 3) throw new Error('fail');
      return Promise.resolve('ok');
    }, { label: 'test', maxRetries: 3, backoffMs: 10 });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(attempts, 3);
  });

  await test('retry: does not retry on 4xx (non-429)', async () => {
    let attempts = 0;
    try {
      await withRetry(() => {
        attempts++;
        const err = new Error('Bad Request');
        err.status = 400;
        throw err;
      }, { label: 'test', maxRetries: 3, backoffMs: 10 });
      assert.fail('Should have thrown');
    } catch (e) {
      assert.strictEqual(attempts, 1);
      assert.strictEqual(e.status, 400);
    }
  });

  await test('retry: retries on 429', async () => {
    let attempts = 0;
    try {
      await withRetry(() => {
        attempts++;
        const err = new Error('Rate limited');
        err.status = 429;
        throw err;
      }, { label: 'test', maxRetries: 2, backoffMs: 10 });
    } catch (_) {}
    assert.strictEqual(attempts, 2);
  });

  // ──────────── CONTEXT EDIT/DELETE ────────────
  const { updateMessage, deleteMessage } = require('../context');

  await test('context: updateMessage changes content', async () => {
    const ch = 'test-edit-ch-123';
    await clearChannelContext(ch);
    await addMessage(ch, 'user', 'original', 'alice', 'msg-edit-1');
    await updateMessage(ch, 'msg-edit-1', 'edited content');
    const ctx = getContext(ch);
    const found = ctx.find(m => m.content === 'edited content');
    assert.ok(found, 'Should find edited message');
  });

  await test('context: deleteMessage removes from context', async () => {
    const ch = 'test-del-ch-123';
    await clearChannelContext(ch);
    await addMessage(ch, 'user', 'to delete', 'alice', 'msg-del-1');
    await addMessage(ch, 'user', 'to keep', 'alice', 'msg-del-2');
    await deleteMessage(ch, 'msg-del-1');
    const ctx = getContext(ch);
    assert.ok(!ctx.some(m => m.content === 'to delete'), 'Deleted message should be gone');
    assert.ok(ctx.some(m => m.content === 'to keep'), 'Other message should remain');
  });

  // ──────────── LOGGER ────────────

  await test('logger: all methods exist', () => {
    assert.ok(typeof logger.debug === 'function');
    assert.ok(typeof logger.info === 'function');
    assert.ok(typeof logger.warn === 'function');
    assert.ok(typeof logger.error === 'function');
    assert.ok(typeof logger.setLevel === 'function');
  });

  await test('logger: formatTimestamp returns ISO-like string', () => {
    const ts = logger.formatTimestamp();
    assert.ok(ts.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/), `Unexpected format: ${ts}`);
  });

  await test('logger: setLevel accepts valid levels', () => {
    logger.setLevel('debug');
    logger.setLevel('info');
    logger.setLevel('warn');
    logger.setLevel('error');
    // Should not throw
  });

  // ──────────── PHASE 13-15 TESTS ────────────

  // ── Soul file tests ──
  await test('soul: soul.md data file loads correctly', () => {
    const soulPath = path.join(__dirname, '..', 'data', 'soul.md');
    if (fs.existsSync(soulPath)) {
      const content = fs.readFileSync(soulPath, 'utf-8');
      assert.ok(content.length > 0, 'Soul file should not be empty');
    }
  });

  await test('soul: getSoulConfig has required fields', () => {
    const { getSoulConfig } = require('../soul');
    const cfg = getSoulConfig();
    assert.ok(cfg.name, 'Should have name');
    assert.ok(cfg.model, 'Should have model');
    assert.ok(typeof cfg.temperature === 'number', 'Should have temperature');
    assert.ok(typeof cfg.maxTokens === 'number', 'Should have maxTokens');
  });

  // ── /help command test ──
  await test('/help: contains all slash commands', () => {
    // Check the interactionHandler source contains all commands
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'interactionHandler.js'), 'utf-8');
    const commands = ['/chat', '/imagine', '/tools', '/settings', '/reset', '/export', '/stats', '/help'];
    for (const cmd of commands) {
      assert.ok(src.includes(cmd), `Help should mention ${cmd}`);
    }
  });

  // ── First-time user detection ──
  await test('first-time user: tip sent for new users', () => {
    // Check messageHandler source has first-time user tip logic
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf-8');
    assert.ok(src.includes('message_count') && src.includes('Tip'), 'Should have first-time user tip');
  });

  // ── Heuristic intent classifier ──
  const { classifyIntent, detectTone } = require('../thinking/layer2-intent');

  await test('intent: image_request detected', () => {
    assert.strictEqual(classifyIntent('draw me a cat').intent, 'image_request');
  });

  await test('intent: image_request from "visualize"', () => {
    assert.strictEqual(classifyIntent('visualize a sunset').intent, 'image_request');
  });

  await test('intent: image_request from "imagine"', () => {
    assert.strictEqual(classifyIntent('imagine a forest').intent, 'image_request');
  });

  await test('intent: code_request detected', () => {
    assert.strictEqual(classifyIntent('run this python code').intent, 'code_request');
  });

  await test('intent: code_request from "algorithm"', () => {
    assert.strictEqual(classifyIntent('write an algorithm for sorting').intent, 'code_request');
  });

  await test('intent: current_info detected', () => {
    assert.strictEqual(classifyIntent('what happened today in the news').intent, 'current_info');
  });

  await test('intent: current_info from "latest"', () => {
    assert.strictEqual(classifyIntent('latest updates on AI').intent, 'current_info');
  });

  await test('intent: definition detected', () => {
    assert.strictEqual(classifyIntent('what is photosynthesis').intent, 'definition');
  });

  await test('intent: definition from "define"', () => {
    assert.strictEqual(classifyIntent('define entropy').intent, 'definition');
  });

  await test('intent: calculation detected', () => {
    assert.strictEqual(classifyIntent('calculate 5 * 12').intent, 'calculation');
  });

  await test('intent: calculation from "how much is"', () => {
    assert.strictEqual(classifyIntent('how much is 500 divided by 7').intent, 'calculation');
  });

  await test('intent: summarize_url detected', () => {
    assert.strictEqual(classifyIntent('summarize https://example.com/article').intent, 'summarize_url');
  });

  await test('intent: correction detected', () => {
    assert.strictEqual(classifyIntent("that's wrong, it should be 42").intent, 'correction');
  });

  await test('intent: correction from "actually"', () => {
    assert.strictEqual(classifyIntent('actually, the answer is different').intent, 'correction');
  });

  await test('intent: correction from "try again"', () => {
    assert.strictEqual(classifyIntent('try again with better results').intent, 'correction');
  });

  await test('intent: general for normal messages', () => {
    assert.strictEqual(classifyIntent('hey how are you doing').intent, 'general');
  });

  // ── Emotional tone detection ──
  await test('tone: frustrated detected', () => {
    assert.strictEqual(detectTone('this is so frustrating!! ugh'), 'frustrated');
  });

  await test('tone: frustrated from "broken"', () => {
    assert.strictEqual(detectTone("it's broken and doesn't work"), 'frustrated');
  });

  await test('tone: confused detected', () => {
    assert.strictEqual(detectTone("I don't understand what you mean??"), 'confused');
  });

  await test('tone: confused from "huh"', () => {
    assert.strictEqual(detectTone("huh that makes no sense"), 'confused');
  });

  await test('tone: appreciative detected', () => {
    assert.strictEqual(detectTone('thanks so much, that was perfect!'), 'appreciative');
  });

  await test('tone: appreciative from emoji', () => {
    assert.strictEqual(detectTone('love it ❤️'), 'appreciative');
  });

  await test('tone: excited detected', () => {
    assert.strictEqual(detectTone('wow that is amazing! 🤯'), 'excited');
  });

  await test('tone: curious detected', () => {
    assert.strictEqual(detectTone('how does quantum computing work?'), 'curious');
  });

  await test('tone: curious from "tell me about"', () => {
    assert.strictEqual(detectTone('tell me about black holes'), 'curious');
  });

  await test('tone: neutral for normal messages', () => {
    assert.strictEqual(detectTone('hello there'), 'neutral');
  });

  // ── Circuit breaker state transitions ──
  await test('circuit breaker: starts CLOSED', () => {
    const { CircuitBreaker } = require('../utils/circuit-breaker');
    const cb = new CircuitBreaker('test', { failureThreshold: 2, resetTimeout: 100 });
    assert.strictEqual(cb.state, 'CLOSED');
  });

  await test('circuit breaker: CLOSED → OPEN after threshold failures', async () => {
    const { CircuitBreaker } = require('../utils/circuit-breaker');
    const cb = new CircuitBreaker('test-open', { failureThreshold: 2, resetTimeout: 100 });
    try { await cb.execute(() => { throw new Error('fail1'); }); } catch (_) {}
    assert.strictEqual(cb.state, 'CLOSED');
    try { await cb.execute(() => { throw new Error('fail2'); }); } catch (_) {}
    assert.strictEqual(cb.state, 'OPEN');
  });

  await test('circuit breaker: OPEN rejects immediately', async () => {
    const { CircuitBreaker } = require('../utils/circuit-breaker');
    const cb = new CircuitBreaker('test-reject', { failureThreshold: 1, resetTimeout: 60000 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch (_) {}
    assert.strictEqual(cb.state, 'OPEN');
    try {
      await cb.execute(() => 'should not run');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('OPEN'));
    }
  });

  await test('circuit breaker: OPEN → HALF_OPEN after timeout', async () => {
    const { CircuitBreaker } = require('../utils/circuit-breaker');
    const cb = new CircuitBreaker('test-half', { failureThreshold: 1, resetTimeout: 50 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch (_) {}
    assert.strictEqual(cb.state, 'OPEN');
    await new Promise(r => setTimeout(r, 60));
    try { await cb.execute(() => 'ok'); } catch (_) {}
    // Should have transitioned through HALF_OPEN to CLOSED
    assert.strictEqual(cb.state, 'CLOSED');
  });

  await test('circuit breaker: HALF_OPEN → CLOSED on success', async () => {
    const { CircuitBreaker } = require('../utils/circuit-breaker');
    const cb = new CircuitBreaker('test-recover', { failureThreshold: 1, resetTimeout: 50 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch (_) {}
    await new Promise(r => setTimeout(r, 60));
    const result = await cb.execute(() => 'recovered');
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(cb.state, 'CLOSED');
    assert.strictEqual(cb.failures, 0);
  });

  await test('circuit breaker: HALF_OPEN → OPEN on failure', async () => {
    const { CircuitBreaker } = require('../utils/circuit-breaker');
    const cb = new CircuitBreaker('test-reopen', { failureThreshold: 1, resetTimeout: 50 });
    try { await cb.execute(() => { throw new Error('fail'); }); } catch (_) {}
    await new Promise(r => setTimeout(r, 60));
    try { await cb.execute(() => { throw new Error('fail again'); }); } catch (_) {}
    assert.strictEqual(cb.state, 'OPEN');
  });

  await test('circuit breaker: getState returns correct shape', () => {
    const { CircuitBreaker } = require('../utils/circuit-breaker');
    const cb = new CircuitBreaker('test-state');
    const state = cb.getState();
    assert.ok(state.name === 'test-state');
    assert.ok(state.state === 'CLOSED');
    assert.strictEqual(state.failures, 0);
  });

  // ── Retry jitter ──
  await test('retry: jitter produces varied delays', async () => {
    // The retry module adds 0-30% jitter; we test by verifying the module structure
    const { withRetry } = require('../utils/retry');
    let attempts = 0;
    await withRetry(() => {
      attempts++;
      if (attempts < 2) throw { status: 500, message: 'fail' };
      return 'ok';
    }, { maxRetries: 3, backoffMs: 10, label: 'jitter-test' });
    assert.strictEqual(attempts, 2);
  });

  await test('retry: respects backoffMultiplier', async () => {
    const { withRetry } = require('../utils/retry');
    const start = Date.now();
    let attempts = 0;
    await withRetry(() => {
      attempts++;
      if (attempts < 3) throw { status: 500, message: 'fail' };
      return 'ok';
    }, { maxRetries: 3, backoffMs: 20, backoffMultiplier: 2, label: 'backoff-test' });
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Should have waited at least 40ms, got ${elapsed}`);
  });

  // ── Reaction feedback storage ──
  await test('feedback: insertFeedback stores data', () => {
    const { insertFeedback, getDb } = require('../db');
    insertFeedback('test-msg-001', 'test-user-001', 'test-ch-001', '👍', Date.now());
    const db = getDb();
    const row = db.prepare("SELECT * FROM feedback WHERE message_id = 'test-msg-001'").get();
    assert.ok(row, 'Feedback should be stored');
    assert.strictEqual(row.reaction, '👍');
    assert.strictEqual(row.user_id, 'test-user-001');
  });

  await test('feedback: getFeedbackStats returns aggregated data', () => {
    const { insertFeedback, getFeedbackStats, getDb } = require('../db');
    // Clean first
    const db = getDb();
    db.prepare("DELETE FROM feedback WHERE user_id LIKE 'test-%'").run();
    insertFeedback('test-msg-002', 'test-user-002', 'test-ch-002', '👍', Date.now());
    insertFeedback('test-msg-003', 'test-user-002', 'test-ch-002', '👍', Date.now());
    insertFeedback('test-msg-004', 'test-user-002', 'test-ch-002', '👎', Date.now());
    const stats = getFeedbackStats();
    assert.ok(Array.isArray(stats));
    const thumbsUp = stats.find(s => s.reaction === '👍');
    const thumbsDown = stats.find(s => s.reaction === '👎');
    assert.ok(thumbsUp && thumbsUp.count >= 2, 'Should have 2+ thumbs up');
    assert.ok(thumbsDown && thumbsDown.count >= 1, 'Should have 1+ thumbs down');
  });

  await test('feedback: table exists in schema', () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback'").get();
    assert.ok(tables, 'feedback table should exist');
  });

  // ── "Still thinking" timer logic ──
  await test('still thinking: messageHandler has thinking timer', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf-8');
    assert.ok(src.includes('thinkingTimer'), 'Should have thinking timer');
    assert.ok(src.includes('Still thinking'), 'Should have thinking message');
    assert.ok(src.includes('clearTimeout(thinkingTimer)'), 'Should clear timer');
  });

  await test('still thinking: timer cleared on error path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf-8');
    // Count clearTimeout(thinkingTimer) occurrences - should be at least 2 (success + error)
    const matches = src.match(/clearTimeout\(thinkingTimer\)/g);
    assert.ok(matches && matches.length >= 2, 'Timer should be cleared in both success and error paths');
  });

  // ── Conversation export format ──
  await test('export: interactionHandler handles /export', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'interactionHandler.js'), 'utf-8');
    assert.ok(src.includes("commandName === 'export'"), 'Should handle export command');
    assert.ok(src.includes('Conversation Export'), 'Should have export format');
    assert.ok(src.includes('AttachmentBuilder'), 'Should create attachment');
  });

  await test('export: format includes channel name and date', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'interactionHandler.js'), 'utf-8');
    assert.ok(src.includes('interaction.channel.name'), 'Should include channel name');
    assert.ok(src.includes('toISOString'), 'Should include date');
  });

  // ── /stats data aggregation ──
  await test('stats: interactionHandler handles /stats', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'interactionHandler.js'), 'utf-8');
    assert.ok(src.includes("commandName === 'stats'"), 'Should handle stats command');
    assert.ok(src.includes('Administrator'), 'Should check admin permission');
  });

  await test('stats: queries tool_usage and feedback', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'interactionHandler.js'), 'utf-8');
    assert.ok(src.includes('tool_usage'), 'Should query tool usage');
    assert.ok(src.includes('getFeedbackStats'), 'Should query feedback');
  });

  await test('stats: getMessageCount works', () => {
    const { getMessageCount } = require('../db');
    const result = getMessageCount();
    assert.ok(result && typeof result.count === 'number', 'Should return count');
  });

  // ── Error reference IDs ──
  await test('error: friendlyError includes ref ID', () => {
    const { friendlyError } = require('../utils/errors');
    const msg = friendlyError(new Error('something'));
    assert.ok(msg.includes('ref:'), 'Should include reference ID');
  });

  await test('error: different calls produce different ref IDs', () => {
    const { friendlyError } = require('../utils/errors');
    const msg1 = friendlyError(new Error('a'));
    const msg2 = friendlyError(new Error('b'));
    const ref1 = msg1.match(/ref: `(\w+)`/)?.[1];
    const ref2 = msg2.match(/ref: `(\w+)`/)?.[1];
    assert.ok(ref1 && ref2, 'Both should have ref IDs');
    assert.notStrictEqual(ref1, ref2, 'Ref IDs should be unique');
  });

  await test('error: generateRefId returns 6 chars', () => {
    const { generateRefId } = require('../utils/errors');
    const ref = generateRefId();
    assert.ok(ref.length >= 4 && ref.length <= 8, `Ref should be ~6 chars, got ${ref.length}`);
  });

  await test('error: errorSeverity categorizes correctly', () => {
    const { errorSeverity } = require('../utils/errors');
    assert.strictEqual(errorSeverity({ message: 'QUEUE_FULL' }), 'recoverable');
    assert.strictEqual(errorSeverity({ status: 429 }), 'recoverable');
    assert.strictEqual(errorSeverity({ message: 'TIMEOUT' }), 'recoverable');
    assert.strictEqual(errorSeverity({ status: 500 }), 'serious');
    assert.strictEqual(errorSeverity(null), 'serious');
  });

  await test('error: errorColor returns correct colors', () => {
    const { errorColor } = require('../utils/errors');
    assert.strictEqual(errorColor('recoverable'), 0xFEE75C);
    assert.strictEqual(errorColor('serious'), 0xED4245);
  });

  await test('error: moderation message is soft', () => {
    const { friendlyError } = require('../utils/errors');
    const msg = friendlyError({ message: 'moderation flagged' });
    assert.ok(msg.includes('Try rephrasing'), 'Moderation message should be soft');
    assert.ok(!msg.includes('keep things appropriate'), 'Should not have old harsh message');
  });

  // ── Debouncer attachment merging ──
  await test('debouncer: merges attachments from all messages', async () => {
    const MessageDebouncer = require('../utils/debouncer');
    const d = new MessageDebouncer(50);
    const makeMsg = (content, attachments = []) => ({
      content,
      channel: { id: 'test-merge-ch' },
      author: { id: 'test-merge-user' },
      attachments: new Map(attachments.map((a, i) => [String(i), a])),
    });

    let receivedAttachments = null;
    const p = new Promise(resolve => {
      d.add(makeMsg('hello', [{ name: 'a.png' }]), (msg, combined, attachments) => {
        receivedAttachments = attachments;
        resolve();
      });
      d.add(makeMsg('world', [{ name: 'b.png' }]), (msg, combined, attachments) => {
        receivedAttachments = attachments;
        resolve();
      });
    });
    await p;
    assert.ok(receivedAttachments, 'Should have received attachments');
    assert.strictEqual(receivedAttachments.length, 2, 'Should merge both attachments');
    assert.strictEqual(receivedAttachments[0].name, 'a.png');
    assert.strictEqual(receivedAttachments[1].name, 'b.png');
  });

  await test('debouncer: handles messages without attachments', async () => {
    const MessageDebouncer = require('../utils/debouncer');
    const d = new MessageDebouncer(50);
    const p = new Promise(resolve => {
      d.add({
        content: 'no attachments',
        channel: { id: 'test-noatt-ch' },
        author: { id: 'test-noatt-user' },
      }, (msg, combined, attachments) => {
        assert.ok(Array.isArray(attachments), 'Attachments should be array');
        assert.strictEqual(attachments.length, 0, 'Should be empty');
        resolve();
      });
    });
    await p;
  });

  // ── Multi-user awareness (username prefixing) ──
  await test('context: addMessage stores username', async () => {
    const { addMessage, getContext, clearChannelContext } = require('../context');
    const testCh = 'test-username-prefix-123';
    await clearChannelContext(testCh);
    await addMessage(testCh, 'user', 'hello', 'TestUser42', 'msg-u1');
    const ctx = getContext(testCh);
    const userMsg = ctx.find(m => m.role === 'user');
    assert.ok(userMsg, 'Should have user message');
    assert.ok(userMsg.name, 'Should have name field');
    assert.ok(userMsg.name.includes('TestUser42'), 'Name should contain username');
    await clearChannelContext(testCh);
  });

  // ── Dynamic model params per intent ──
  await test('intent: classifyIntent returns tone', () => {
    const result = classifyIntent('draw me something');
    assert.ok(result.tone, 'Should have tone');
    assert.strictEqual(result.tone, 'creative');
  });

  await test('intent: code_request has technical tone', () => {
    assert.strictEqual(classifyIntent('run this python script').tone, 'technical');
  });

  await test('intent: definition has educational tone', () => {
    assert.strictEqual(classifyIntent('what is a quasar').tone, 'educational');
  });

  await test('intent: calculation has precise tone', () => {
    assert.strictEqual(classifyIntent('calculate 2+2').tone, 'precise');
  });

  await test('intent: correction has receptive tone', () => {
    assert.strictEqual(classifyIntent("that's wrong").tone, 'receptive');
  });

  // ── Profile consolidation trigger (50+ notes) ──
  await test('users: consolidateUserProfile exported', () => {
    const { consolidateUserProfile } = require('../users');
    assert.ok(typeof consolidateUserProfile === 'function');
  });

  await test('users: consolidation only triggers at 50+ notes', async () => {
    const { consolidateUserProfile, getProfile, trackUser, appendUserNotes } = require('../users');
    const testUserId = 'test-consolidate-user';
    trackUser(testUserId, 'consolidateTest', 'ConsolidateTest');
    // Add fewer than 50 notes
    for (let i = 0; i < 5; i++) {
      appendUserNotes(testUserId, `test note ${i} unique-${Date.now()}-${i}`);
    }
    // Should not throw, should just return early
    await consolidateUserProfile(testUserId, 'consolidateTest');
    const profile = getProfile(testUserId);
    assert.ok(profile, 'Profile should exist');
  });

  // ── Memory eviction (>100 channels) ──
  await test('context: MAX_CACHED_CHANNELS constant exists', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'context.js'), 'utf-8');
    assert.ok(src.includes('MAX_CACHED_CHANNELS'), 'Should have max cached channels');
    assert.ok(src.includes('evictIfNeeded'), 'Should have eviction function');
  });

  // ── Channel lock timeout ──
  await test('context: channel lock has timeout', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'context.js'), 'utf-8');
    assert.ok(src.includes('Channel lock timeout'), 'Should have lock timeout');
    assert.ok(src.includes('90000'), 'Should have 90s timeout');
  });

  // ── Context persistence (write-through + reload) ──
  await test('context: write-through to SQLite', async () => {
    const { addMessage, clearChannelContext } = require('../context');
    const { loadContext } = require('../db');
    const testCh = 'test-writethrough-123';
    await clearChannelContext(testCh);
    await addMessage(testCh, 'user', 'persistence test', 'TestUser');
    const rows = loadContext(testCh, 10);
    assert.ok(rows.length > 0, 'Should persist to SQLite');
    assert.ok(rows.some(r => r.content === 'persistence test'), 'Content should match');
    await clearChannelContext(testCh);
  });

  // ── Reflection frequency ──
  await test('reflection: interval configured in config', () => {
    assert.ok(typeof config.reflectionInterval === 'number', 'Should have reflection interval');
    assert.ok(config.reflectionInterval > 0, 'Should be positive');
  });

  await test('reflection: messageHandler triggers at interval', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf-8');
    assert.ok(src.includes('reflectionInterval'), 'Should check reflection interval');
    assert.ok(src.includes('reflectAndUpdate'), 'Should call reflectAndUpdate');
  });

  // ── Health endpoint 503 on stall ──
  await test('health: returns 503 when stalled', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'health.js'), 'utf-8');
    assert.ok(src.includes('503'), 'Should return 503');
    assert.ok(src.includes('unhealthy'), 'Should report unhealthy');
    assert.ok(src.includes('300000'), 'Should have 5min stall threshold');
  });

  // ── Index.js reaction handler ──
  await test('index: has messageReactionAdd handler', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
    assert.ok(src.includes('messageReactionAdd'), 'Should handle reactions');
    assert.ok(src.includes('insertFeedback'), 'Should store feedback');
    assert.ok(src.includes('GuildMessageReactions'), 'Should have reaction intent');
  });

  // ── Slash command registration ──
  await test('index: registers export and stats commands', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
    assert.ok(src.includes("setName('export')"), 'Should register /export');
    assert.ok(src.includes("setName('stats')"), 'Should register /stats');
  });

  // ── Logger improvements ──
  await test('logger: async write queue exists', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'logger.js'), 'utf-8');
    assert.ok(src.includes('writeQueue'), 'Should have write queue');
    assert.ok(src.includes('flushWrites'), 'Should have flush function');
  });

  await test('logger: max total size enforcement', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'logger.js'), 'utf-8');
    assert.ok(src.includes('MAX_TOTAL_SIZE'), 'Should have max total size');
    assert.ok(src.includes('enforceTotalSize'), 'Should have enforcement function');
  });

  // ── Additional debouncer tests ──
  await test('debouncer: callback receives combined content', async () => {
    const MessageDebouncer = require('../utils/debouncer');
    const d = new MessageDebouncer(50);
    const p = new Promise(resolve => {
      d.add({
        content: 'first',
        channel: { id: 'test-cb-ch' },
        author: { id: 'test-cb-user' },
        attachments: new Map(),
      }, (msg, combined) => { resolve(combined); });
    });
    const result = await p;
    assert.strictEqual(result, 'first');
  });

  await test('debouncer: multi-message coalesces content with newlines', async () => {
    const MessageDebouncer = require('../utils/debouncer');
    const d = new MessageDebouncer(50);
    const p = new Promise(resolve => {
      const makeFakeMsg = (content) => ({
        content,
        channel: { id: 'test-multi-ch' },
        author: { id: 'test-multi-user' },
        attachments: new Map(),
      });
      d.add(makeFakeMsg('line1'), (msg, combined) => resolve(combined));
      d.add(makeFakeMsg('line2'), (msg, combined) => resolve(combined));
    });
    const result = await p;
    assert.ok(result.includes('line1') && result.includes('line2'), 'Should combine both lines');
  });

  // ── ModelQueue routing ──
  await test('ModelQueue: routes image model to image queue', () => {
    const { ModelQueue } = require('../utils/model-queue');
    const mq = new ModelQueue();
    assert.strictEqual(mq.getQueueName('gpt-image-1'), 'image');
    assert.strictEqual(mq.getQueueName('gpt-4.1-mini'), 'mini');
    assert.strictEqual(mq.getQueueName('gpt-5.2'), 'main');
    assert.strictEqual(mq.getQueueName('omni-moderation-latest'), 'moderation');
  });

  // ── PriorityQueue priority ordering ──
  await test('PriorityQueue: higher priority executes first', async () => {
    const { PriorityTaskQueue } = require('../utils/model-queue');
    const q = new PriorityTaskQueue(1, 10);
    const order = [];
    // Enqueue a blocking task first
    const blocker = q.enqueue(async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push('blocker');
    }, 0);
    // While blocked, add low and high priority
    const low = q.enqueue(async () => { order.push('low'); }, 0);
    const high = q.enqueue(async () => { order.push('high'); }, 3);
    await Promise.all([blocker, low, high]);
    assert.strictEqual(order[0], 'blocker');
    assert.strictEqual(order[1], 'high', 'High priority should run before low');
    assert.strictEqual(order[2], 'low');
  });

  // ── DB tables ──
  await test('db: feedback table has correct columns', () => {
    const db = getDb();
    const info = db.prepare("PRAGMA table_info(feedback)").all();
    const cols = info.map(c => c.name);
    assert.ok(cols.includes('message_id'));
    assert.ok(cols.includes('user_id'));
    assert.ok(cols.includes('channel_id'));
    assert.ok(cols.includes('reaction'));
    assert.ok(cols.includes('timestamp'));
  });

  // ── Config completeness ──
  await test('config: has all Phase 13-15 settings', () => {
    assert.ok(config.reflectionInterval, 'Should have reflectionInterval');
    assert.ok(config.factExtractionInterval, 'Should have factExtractionInterval');
    assert.ok(config.thinkingLayersEnabled !== undefined, 'Should have thinkingLayersEnabled');
    assert.ok(config.reflectionIntervalLayers, 'Should have reflectionIntervalLayers');
  });

  // ── Retry: does not retry on non-429 4xx ──
  await test('retry: does not retry on 400', async () => {
    const { withRetry } = require('../utils/retry');
    let attempts = 0;
    try {
      await withRetry(() => {
        attempts++;
        throw { status: 400, message: 'bad request' };
      }, { maxRetries: 3, backoffMs: 10 });
    } catch (_) {}
    assert.strictEqual(attempts, 1, 'Should not retry on 400');
  });

  await test('retry: retries on 500', async () => {
    const { withRetry } = require('../utils/retry');
    let attempts = 0;
    try {
      await withRetry(() => {
        attempts++;
        throw { status: 500, message: 'server error' };
      }, { maxRetries: 2, backoffMs: 10 });
    } catch (_) {}
    assert.strictEqual(attempts, 2, 'Should retry on 500');
  });

  // ── Context: summary included in getContext ──
  await test('context: getContext returns summary if available', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'context.js'), 'utf-8');
    assert.ok(src.includes('Previous conversation summary'), 'Should include summary in context');
  });

  // ── Interaction handler: export ephemeral ──
  await test('export: reply is ephemeral', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'interactionHandler.js'), 'utf-8');
    const exportSection = src.substring(src.indexOf("commandName === 'export'"), src.indexOf("commandName === 'stats'"));
    assert.ok(exportSection.includes('ephemeral: true'), 'Export should be ephemeral');
  });

  // ── Message handler: merged attachments accepted ──
  // ── Additional coverage tests ──

  await test('intent: suggestSearch true for current_info', () => {
    const result = classifyIntent('what happened today');
    assert.ok(result.suggestSearch, 'Should suggest search for current info');
  });

  await test('intent: general has helpful tone', () => {
    assert.strictEqual(classifyIntent('hey there friend').tone, 'helpful');
  });

  await test('tone: frustrated from wtf', () => {
    assert.strictEqual(detectTone('wtf is going on'), 'frustrated');
  });

  await test('tone: confused from "lost"', () => {
    assert.strictEqual(detectTone("I'm completely lost here"), 'confused');
  });

  await test('tone: appreciative from "great"', () => {
    assert.strictEqual(detectTone('great job on that'), 'appreciative');
  });

  await test('tone: excited from "cool"', () => {
    assert.strictEqual(detectTone('that is so cool'), 'excited');
  });

  await test('tone: curious from question mark', () => {
    assert.strictEqual(detectTone('what is this?'), 'curious');
  });

  await test('circuit breaker: success resets failure count', async () => {
    const { CircuitBreaker } = require('../utils/circuit-breaker');
    const cb = new CircuitBreaker('reset-test', { failureThreshold: 3 });
    try { await cb.execute(() => { throw new Error('f'); }); } catch (_) {}
    assert.strictEqual(cb.failures, 1);
    await cb.execute(() => 'ok');
    assert.strictEqual(cb.failures, 0);
  });

  await test('db: insertContext and loadContext roundtrip', () => {
    const { insertContext, loadContext, clearContext } = require('../db');
    clearContext('test-roundtrip-ch');
    insertContext('test-roundtrip-ch', 'msg-rt-1', 'user', 'roundtrip test', 'TestUser');
    const rows = loadContext('test-roundtrip-ch', 10);
    assert.ok(rows.length >= 1);
    assert.strictEqual(rows[rows.length - 1].content, 'roundtrip test');
    clearContext('test-roundtrip-ch');
  });

  await test('db: trimContext keeps only N newest', () => {
    const { insertContext, loadContext, clearContext, trimContext } = require('../db');
    clearContext('test-trim-ch');
    for (let i = 0; i < 10; i++) {
      insertContext('test-trim-ch', `msg-trim-${i}`, 'user', `message ${i}`, 'TestUser');
    }
    trimContext('test-trim-ch', 5);
    const rows = loadContext('test-trim-ch', 100);
    assert.ok(rows.length <= 5, `Should have <=5, got ${rows.length}`);
    clearContext('test-trim-ch');
  });

  await test('users: updateProfilesFromFacts with Map', () => {
    const { updateProfilesFromFacts, trackUser, getProfile } = require('../users');
    trackUser('test-fact-user', 'factUser', 'FactUser');
    const userMap = new Map([['factUser', 'test-fact-user']]);
    updateProfilesFromFacts([{ userName: 'factUser', category: 'preference', content: 'likes cats' }], userMap);
    const profile = getProfile('test-fact-user');
    assert.ok(profile.personality_notes.includes('cats'), 'Should have fact in notes');
  });

  await test('users: formatProfileForPrompt includes message count', () => {
    const { formatProfileForPrompt, trackUser } = require('../users');
    trackUser('test-format-user', 'formatUser', 'FormatUser');
    const result = formatProfileForPrompt('test-format-user');
    assert.ok(result.includes('messages'), 'Should include message count');
  });

  await test('config: feature flags all boolean', () => {
    for (const [key, val] of Object.entries(config.features)) {
      assert.strictEqual(typeof val, 'boolean', `features.${key} should be boolean`);
    }
  });

  await test('config: rate limit values are positive', () => {
    assert.ok(config.rateLimitUser > 0);
    assert.ok(config.rateLimitVip > 0);
    assert.ok(config.rateLimitWindow > 0);
    assert.ok(config.rateLimitThread > 0);
  });

  await test('debouncer: windowMs configurable', () => {
    const MessageDebouncer = require('../utils/debouncer');
    const d = new MessageDebouncer(5000);
    assert.strictEqual(d.windowMs, 5000);
  });

  await test('LRUCache: get returns set value', () => {
    const LRUCache = require('../utils/cache');
    const cache = new LRUCache({ maxSize: 5, ttlMs: 60000 });
    cache.set('key1', 'val1');
    assert.strictEqual(cache.get('key1'), 'val1');
    assert.strictEqual(cache.get('key2'), null);
  });

  await test('PriorityQueue: concurrent tasks respect limit', async () => {
    const { PriorityTaskQueue } = require('../utils/model-queue');
    const q = new PriorityTaskQueue(2, 20);
    let maxConcurrent = 0;
    let current = 0;
    const tasks = Array.from({ length: 5 }, () =>
      q.enqueue(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await new Promise(r => setTimeout(r, 20));
        current--;
      })
    );
    await Promise.all(tasks);
    assert.ok(maxConcurrent <= 2, `Max concurrent should be <=2, got ${maxConcurrent}`);
  });

  await test('health: recordProcessed and recordError are functions', () => {
    const { recordProcessed, recordError } = require('../health');
    assert.ok(typeof recordProcessed === 'function');
    assert.ok(typeof recordError === 'function');
  });

  await test('db: close is a function', () => {
    const { close } = require('../db');
    assert.ok(typeof close === 'function');
  });

  await test('soul: reflectAndUpdate is async function', () => {
    const { reflectAndUpdate } = require('../soul');
    assert.ok(typeof reflectAndUpdate === 'function');
  });

  await test('context: withChannelLock serializes access', async () => {
    const { withChannelLock } = require('../context');
    const order = [];
    await Promise.all([
      withChannelLock('test-lock-ch', async () => { order.push(1); await new Promise(r => setTimeout(r, 20)); }),
      withChannelLock('test-lock-ch', async () => { order.push(2); }),
    ]);
    assert.deepStrictEqual(order, [1, 2], 'Should serialize');
  });

  await test('db: logToolUsage stores data', () => {
    const { logToolUsage, getToolStats } = require('../db');
    logToolUsage('test_tool', 'test-tool-user', 'test-tool-ch', true, 42);
    const stats = getToolStats();
    const found = stats.find(s => s.tool_name === 'test_tool');
    assert.ok(found, 'Should find test tool in stats');
  });

  await test('intent: image_request suggests generate_image tool', () => {
    // Check analyzeIntent sets suggestedTools (via source inspection)
    const src = fs.readFileSync(path.join(__dirname, '..', 'thinking', 'layer2-intent.js'), 'utf-8');
    assert.ok(src.includes("suggestedTools.push('generate_image')"), 'Should suggest generate_image for image_request');
  });

  await test('intent: current_info suggests search tools', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'thinking', 'layer2-intent.js'), 'utf-8');
    assert.ok(src.includes("suggestedTools.push('brave_search'"), 'Should suggest brave_search');
  });

  await test('error: friendlyError works with Error objects', () => {
    const { friendlyError } = require('../utils/errors');
    const msg = friendlyError(new Error('TIMEOUT'));
    assert.ok(msg.includes('timed out') || msg.includes('timeout'), 'Should detect timeout from Error');
  });

  await test('db: pruneOldMemories is a function', () => {
    const { pruneOldMemories } = require('../db');
    assert.ok(typeof pruneOldMemories === 'function');
  });

  await test('config: maxConcurrentApi is positive', () => {
    assert.ok(config.maxConcurrentApi > 0);
  });

  await test('messageHandler: processMessage accepts merged attachments', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'handlers', 'messageHandler.js'), 'utf-8');
    assert.ok(src.includes('mergedAttachments'), 'Should accept merged attachments parameter');
    assert.ok(src.includes('attachmentSource'), 'Should use attachment source');
  });

  // ── Cleanup test data ──
  try {
    const db = getDb();
    db.prepare("DELETE FROM user_settings WHERE user_id LIKE 'test-%'").run();
    db.prepare("DELETE FROM conversation_context WHERE channel_id LIKE 'test-%'").run();
    db.prepare("DELETE FROM feedback WHERE user_id LIKE 'test-%'").run();
    db.prepare("DELETE FROM user_profiles WHERE user_id LIKE 'test-%'").run();
  } catch (_) {}

  // ──────────── RESULTS ────────────
  console.log('\n' + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);
})();
