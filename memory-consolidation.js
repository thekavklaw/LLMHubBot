/**
 * @module memory-consolidation
 * @description Consolidates scattered observation memories into coherent user profiles.
 * Triggered when a user accumulates 15+ unconsolidated memories.
 */

const logger = require('./logger');
const { getMemoriesByUser, markMemoryConsolidated, countUserUnconsolidatedMemories, insertMemory } = require('./db');
const { thinkWithModel } = require('./openai-client');
const { withRetry } = require('./utils/retry');
const { getEmbedding, float32ToBuffer } = require('./memory');
const { appendDailyMemory, appendUserMemory } = require('./memory-files');

/**
 * Consolidate memories for a specific user.
 * Merges all unconsolidated observations into a coherent profile summary.
 * @param {string} userId - Discord user ID
 * @param {string} userName - Display name
 */
async function consolidateUserMemories(userId, userName) {
  const count = countUserUnconsolidatedMemories(userId);
  if (count < 15) {
    logger.debug('Consolidation', `${userName} has only ${count} unconsolidated memories, skipping`);
    return null;
  }

  logger.info('Consolidation', `Consolidating ${count} memories for ${userName} (${userId})`);

  const memories = getMemoriesByUser(userId).filter(m => !m.consolidated);
  if (memories.length < 15) return null;

  // Group by category
  const grouped = {};
  for (const m of memories) {
    const cat = m.category || 'fact';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m);
  }

  const memoriesText = memories.map((m, i) =>
    `${i + 1}. [${m.category}] ${m.content} (${m.timestamp})`
  ).join('\n');

  try {
    const result = await withRetry(() => thinkWithModel([
      {
        role: 'system',
        content: `You are consolidating scattered memory observations about a Discord user into a coherent profile. Merge related facts, remove duplicates, keep the most recent version of contradictory info. Preserve ALL unique information. Return JSON: { "profile": "consolidated profile text (max 800 chars)" }`,
      },
      {
        role: 'user',
        content: `User: ${userName}\n\nMemories (${memories.length} entries):\n${memoriesText}`,
      },
    ], 'gpt-4.1-mini'), { label: 'memory-consolidation', maxRetries: 2 });

    const parsed = JSON.parse(result);
    if (!parsed.profile || parsed.profile.length < 10) {
      logger.warn('Consolidation', `Empty consolidation result for ${userName}`);
      return null;
    }

    // Store consolidated memory
    const content = `[Consolidated Profile] ${parsed.profile}`;
    const embedding = await getEmbedding(content);
    const embeddingBuf = float32ToBuffer(embedding);
    const metadata = JSON.stringify({ originalIds: memories.map(m => m.id), consolidatedAt: new Date().toISOString() });

    insertMemory(content, embeddingBuf, userId, userName, null, 'consolidated', metadata, null, 'curated', 0.95);

    // Mark originals as consolidated
    for (const m of memories) {
      markMemoryConsolidated(m.id);
    }

    // Write to markdown files
    appendDailyMemory(`Consolidated ${memories.length} memories for ${userName}`, 'reflection');
    appendUserMemory(userId, userName, `[consolidated] ${parsed.profile}`);

    logger.info('Consolidation', `Consolidated ${memories.length} memories for ${userName} → ${parsed.profile.length} chars`);
    return parsed.profile;
  } catch (err) {
    logger.error('Consolidation', `Failed for ${userName}:`, err.message);
    return null;
  }
}

/**
 * Check all users and consolidate those with 15+ unconsolidated memories.
 * Run on startup.
 */
async function consolidateAllUsers() {
  try {
    const db = require('./db');
    const users = db.getDb().prepare('SELECT DISTINCT user_id, user_name FROM memories WHERE consolidated = 0 AND user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) >= 15').all();
    
    for (const user of users) {
      await consolidateUserMemories(user.user_id, user.user_name);
    }

    if (users.length > 0) {
      logger.info('Consolidation', `Startup consolidation complete: ${users.length} users processed`);
    }
  } catch (err) {
    logger.error('Consolidation', 'Startup consolidation error:', err.message);
  }
}

module.exports = { consolidateUserMemories, consolidateAllUsers };
