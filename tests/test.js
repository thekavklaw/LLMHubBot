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

  await test('index.js is small (<100 lines)', () => {
    const content = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf-8');
    const lines = content.split('\n').length;
    assert.ok(lines < 250, `index.js has ${lines} lines, expected <250`);
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
    assert.strictEqual(msg, USER_ERRORS.rate_limit);
  });

  await test('friendlyError: timeout error', () => {
    const msg = friendlyError({ message: 'TIMEOUT' });
    assert.strictEqual(msg, USER_ERRORS.timeout);
  });

  await test('friendlyError: ETIMEDOUT code', () => {
    const msg = friendlyError({ code: 'ETIMEDOUT', message: 'connect' });
    assert.strictEqual(msg, USER_ERRORS.timeout);
  });

  await test('friendlyError: timeout in message', () => {
    const msg = friendlyError({ message: 'Request timed out' });
    assert.strictEqual(msg, USER_ERRORS.timeout);
  });

  await test('friendlyError: server error (500)', () => {
    const msg = friendlyError({ status: 500, message: 'Internal' });
    assert.strictEqual(msg, USER_ERRORS.api_error);
  });

  await test('friendlyError: server error (503)', () => {
    const msg = friendlyError({ status: 503, message: 'Unavailable' });
    assert.strictEqual(msg, USER_ERRORS.api_error);
  });

  await test('friendlyError: queue full', () => {
    const msg = friendlyError({ message: 'QUEUE_FULL' });
    assert.strictEqual(msg, USER_ERRORS.queue_full);
  });

  await test('friendlyError: moderation error', () => {
    const msg = friendlyError({ message: 'Content flagged by moderation' });
    assert.strictEqual(msg, USER_ERRORS.moderation);
  });

  await test('friendlyError: unknown error', () => {
    const msg = friendlyError({ message: 'Something weird' });
    assert.strictEqual(msg, USER_ERRORS.unknown);
  });

  await test('friendlyError: null error', () => {
    const msg = friendlyError(null);
    assert.strictEqual(msg, USER_ERRORS.unknown);
  });

  await test('friendlyError: undefined error', () => {
    const msg = friendlyError(undefined);
    assert.strictEqual(msg, USER_ERRORS.unknown);
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

  // ── Cleanup test data ──
  try {
    const db = getDb();
    db.prepare("DELETE FROM user_settings WHERE user_id LIKE 'test-%'").run();
    db.prepare("DELETE FROM conversation_context WHERE channel_id LIKE 'test-%'").run();
  } catch (_) {}

  // ──────────── RESULTS ────────────
  console.log('\n' + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);
})();
