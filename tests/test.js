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

  // ──────────── DB TESTS ────────────
  // db.js creates its own DB on require, so we test the live module
  const db = require('../db');

  await test('db: logMessage + getRecentMessages', () => {
    const ch = 'test-ch-' + Date.now();
    db.logMessage(ch, 'u1', 'TestUser', 'user', 'Hello world');
    db.logMessage(ch, 'bot', 'LLMHub', 'assistant', 'Hi there');
    const msgs = db.getRecentMessages(ch, 10);
    assert.ok(msgs.length >= 2, `Expected >=2 messages, got ${msgs.length}`);
    assert.strictEqual(msgs[msgs.length - 1].content, 'Hi there');
    assert.strictEqual(msgs[msgs.length - 2].content, 'Hello world');
  });

  await test('db: saveSummary + getLatestSummary', () => {
    const ch = 'test-summary-' + Date.now();
    assert.strictEqual(db.getLatestSummary(ch), null);
    db.saveSummary(ch, 'Test summary content', '1-10');
    assert.strictEqual(db.getLatestSummary(ch), 'Test summary content');
    db.saveSummary(ch, 'Updated summary', '11-20');
    assert.strictEqual(db.getLatestSummary(ch), 'Updated summary');
  });

  await test('db: upsertUserProfile + getUserProfile', () => {
    const uid = 'test-user-' + Date.now();
    db.upsertUserProfile(uid, 'testname', 'TestDisplay');
    const p = db.getUserProfile(uid);
    assert.ok(p, 'Profile should exist');
    assert.strictEqual(p.user_name, 'testname');
    assert.strictEqual(p.display_name, 'TestDisplay');
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
    const after = db.getAllMemories().length;
    assert.strictEqual(after, before + 1);
  });

  await test('db: getState + setState', () => {
    const key = 'test-key-' + Date.now();
    assert.strictEqual(db.getState(key), null);
    db.setState(key, 'hello');
    assert.strictEqual(db.getState(key), 'hello');
    db.setState(key, 'updated');
    assert.strictEqual(db.getState(key), 'updated');
  });

  // Check tables exist via the DB file
  await test('db: all required tables exist', () => {
    const Database = require('better-sqlite3');
    const dbFile = new Database(path.join(__dirname, '..', 'llmhub.db'), { readonly: true });
    const tables = dbFile.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    dbFile.close();
    for (const t of ['conversations', 'summaries', 'memories', 'user_profiles', 'bot_state', 'moderation_log']) {
      assert.ok(tables.includes(t), `Missing table: ${t}`);
    }
  });

  // ──────────── SOUL TESTS ────────────
  const soul = require('../soul');

  await test('soul: getSoulConfig returns valid config', () => {
    const cfg = soul.getSoulConfig();
    assert.ok(cfg.model, 'Missing model');
    assert.ok(typeof cfg.temperature === 'number', 'temperature should be number');
    assert.ok(typeof cfg.maxTokens === 'number', 'maxTokens should be number');
    assert.strictEqual(cfg.name, 'LLMHub');
  });

  await test('soul: getSystemPrompt is exported as async function', () => {
    assert.strictEqual(typeof soul.getSystemPrompt, 'function');
  });

  // ──────────── CONTEXT TESTS ────────────
  const context = require('../context');

  await test('context: addMessage + getContext', () => {
    const ch = 'ctx-test-' + Date.now();
    context.addMessage(ch, 'user', 'Hello', 'TestUser');
    const ctx = context.getContext(ch);
    assert.ok(ctx.length >= 1);
    const last = ctx[ctx.length - 1];
    assert.strictEqual(last.role, 'user');
    assert.strictEqual(last.content, 'Hello');
  });

  await test('context: window caps at 20 messages', () => {
    const ch = 'ctx-cap-' + Date.now();
    for (let i = 0; i < 25; i++) {
      context.addMessage(ch, 'user', `msg-${i}`, 'User');
    }
    const ctx = context.getContext(ch);
    // Filter out summary messages
    const userMsgs = ctx.filter(m => m.role === 'user');
    assert.ok(userMsgs.length <= 20, `Expected <=20, got ${userMsgs.length}`);
    assert.strictEqual(userMsgs[0].content, 'msg-5');
    assert.strictEqual(userMsgs[userMsgs.length - 1].content, 'msg-24');
  });

  await test('context: getRecentContextMessages works', () => {
    const ch = 'ctx-recent-' + Date.now();
    context.addMessage(ch, 'user', 'test1', 'U');
    const msgs = context.getRecentContextMessages(ch);
    assert.ok(msgs.length >= 1);
  });

  // ──────────── MODERATOR TESTS ────────────
  const moderator = require('../moderator');

  await test('moderator: exports checkMessage', () => {
    assert.strictEqual(typeof moderator.checkMessage, 'function');
  });

  await test('moderator: exports moderateInput', () => {
    assert.strictEqual(typeof moderator.moderateInput, 'function');
  });

  await test('moderator: exports moderateOutput + checkOutput', () => {
    assert.strictEqual(typeof moderator.moderateOutput, 'function');
    assert.strictEqual(typeof moderator.checkOutput, 'function');
  });

  // ──────────── USERS TESTS ────────────
  const users = require('../users');

  await test('users: trackUser creates profile', () => {
    const uid = 'usr-track-' + Date.now();
    users.trackUser(uid, 'tracker', 'Tracker');
    const p = users.getProfile(uid);
    assert.ok(p, 'Profile should exist after trackUser');
    assert.strictEqual(p.user_name, 'tracker');
  });

  await test('users: appendUserNotes appends notes', () => {
    const uid = 'usr-notes-' + Date.now();
    users.trackUser(uid, 'noter', 'Noter');
    users.appendUserNotes(uid, 'Likes Python');
    users.appendUserNotes(uid, 'Plays guitar');
    const p = users.getProfile(uid);
    assert.ok(p.personality_notes.includes('Likes Python'));
    assert.ok(p.personality_notes.includes('Plays guitar'));
  });

  await test('users: appendUserNotes deduplicates', () => {
    const uid = 'usr-dedup-' + Date.now();
    users.trackUser(uid, 'dedup', 'Dedup');
    users.appendUserNotes(uid, 'Same note');
    users.appendUserNotes(uid, 'Same note');
    const p = users.getProfile(uid);
    const count = (p.personality_notes.match(/Same note/g) || []).length;
    assert.strictEqual(count, 1, 'Note should not be duplicated');
  });

  await test('users: formatProfileForPrompt returns string', () => {
    const uid = 'usr-fmt-' + Date.now();
    users.trackUser(uid, 'fmtuser', 'FmtUser');
    const result = users.formatProfileForPrompt(uid);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('FmtUser'));
  });

  // ──────────── FILE CHECKS ────────────
  const expectedFiles = ['index.js', 'db.js', 'context.js', 'soul.js', 'users.js', 'moderator.js', 'memory.js', 'openai-client.js', 'relevance.js', 'threads.js'];
  await test('all source files exist and have content', () => {
    for (const f of expectedFiles) {
      const fp = path.join(__dirname, '..', f);
      assert.ok(fs.existsSync(fp), `Missing: ${f}`);
      const stat = fs.statSync(fp);
      assert.ok(stat.size > 0, `Empty: ${f}`);
    }
  });

  await test('soul.md data file exists', () => {
    const fp = path.join(__dirname, '..', 'data', 'soul.md');
    assert.ok(fs.existsSync(fp), 'data/soul.md missing');
    const content = fs.readFileSync(fp, 'utf-8');
    assert.ok(content.includes('LLMHub'), 'soul.md should mention LLMHub');
  });

  // ──────────── RESULTS ────────────
  console.log('\n' + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);
})();
