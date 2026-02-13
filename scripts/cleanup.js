const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'llmhub.db'));

// Purge TestUser memories
const testMemories = db.prepare("DELETE FROM memories WHERE content LIKE '%test memory%' OR content LIKE '%TestUser%'").run();
console.log(`Deleted ${testMemories.changes} test memories`);

// Purge test/duplicate user profiles
const testProfiles = db.prepare("DELETE FROM user_profiles WHERE user_id LIKE 'test%' OR user_id = 'noter' OR user_id = 'dedup'").run();
console.log(`Deleted ${testProfiles.changes} test profiles`);

// Purge test conversation summaries (if table exists)
try {
  const testSummaries = db.prepare("DELETE FROM conversation_summaries WHERE summary LIKE '%Test summary%' OR summary LIKE '%test%'").run();
  console.log(`Deleted ${testSummaries.changes} test summaries`);
} catch (_) {
  console.log('No conversation_summaries table — skipped');
}

// Fix wrong memory about Kaveen
const wrongMemory = db.prepare("DELETE FROM memories WHERE content LIKE '%beginner in AI image generation%'").run();
console.log(`Deleted ${wrongMemory.changes} wrong memories`);

console.log('\n=== Remaining Stats ===');
console.log('Memories:', db.prepare('SELECT COUNT(*) as c FROM memories').get().c);
console.log('Profiles:', db.prepare('SELECT COUNT(*) as c FROM user_profiles').get().c);

db.close();
