/**
 * @module memory
 * @description RAG-based long-term memory system. Stores facts with embeddings
 * and retrieves them via cosine similarity search. Includes automatic pruning.
 */

const OpenAI = require('openai');
const { insertMemory, getRecentMemories, getMemoryCount, pruneOldMemories: dbPruneOldMemories, searchFts, countUserUnconsolidatedMemories, touchMemory } = require('./db');
const { appendDailyMemory, appendUserMemory } = require('./memory-files');
const logger = require('./logger');
const config = require('./config');
const { withRetry } = require('./utils/retry');

const openai = new OpenAI({ apiKey: config.openaiApiKey });

// ── LRU Embedding Cache ──
class LRUCache {
  constructor(max) {
    this.max = max;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    // Move to end (most recent)
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, val);
    if (this.cache.size > this.max) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }
  get size() { return this.cache.size; }
}

const embeddingCache = new LRUCache(config.embeddingCacheSize);

async function getEmbedding(text) {
  // Use hash of full text as cache key to avoid collisions
  const crypto = require('crypto');
  const key = crypto.createHash('md5').update(text).digest('hex');
  const cached = embeddingCache.get(key);
  if (cached) return cached;

  const res = await withRetry(() => openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000),
  }), { label: 'embedding' });
  const embedding = new Float32Array(res.data[0].embedding);
  embeddingCache.set(key, embedding);
  return embedding;
}

function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function bufferToFloat32(buf) {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(ab);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Prune memories older than maxAge (default 90 days).
 */
function pruneByAge(maxAge = 90 * 24 * 60 * 60 * 1000) {
  try {
    const mems = getRecentMemories(365); // get all within a year
    let pruned = 0;
    const cutoff = Date.now() - maxAge;
    for (const mem of mems) {
      const ts = new Date(mem.timestamp).getTime();
      if (ts < cutoff) {
        pruned++;
      }
    }
    if (pruned > 0) {
      dbPruneOldMemories(pruned);
      logger.info('Memory', `Age-pruned ${pruned} memories older than ${Math.round(maxAge / 86400000)}d`);
    }
    return pruned;
  } catch (err) {
    logger.error('Memory', 'Age prune error:', err);
    return 0;
  }
}

/**
 * Check for duplicate memory (cosine similarity > 0.95).
 * Returns true if a near-duplicate exists.
 */
async function isDuplicate(embedding, threshold = 0.95) {
  try {
    const recent = getRecentMemories(7); // check last week
    for (const mem of recent) {
      if (!mem.embedding) continue;
      const memEmb = bufferToFloat32(mem.embedding);
      const sim = cosineSimilarity(embedding, memEmb);
      if (sim > threshold) return true;
    }
    return false;
  } catch (err) {
    logger.error('Memory', 'Dedup check error:', err);
    return false;
  }
}

async function storeMemory(content, meta = {}) {
  try {
    const significance = meta.significance ?? 0.5;
    const minSigThreshold = config.memoryMinSignificance ?? 0.5;
    const mdThreshold = config.memoryMdSignificance ?? 0.8;

    // Significance filter: skip trivial memories
    if (significance < minSigThreshold) {
      logger.debug('Memory', `Skipped low-significance (${significance.toFixed(2)}): "${content.slice(0, 60)}..."`);
      return;
    }

    // Prune if over limit (10k cap)
    const count = getMemoryCount();
    const maxMemories = config.memoryMaxRows || 10000;
    if (count > maxMemories) {
      const toDelete = Math.max(Math.floor(count * (config.memoryPrunePercent || 0.1)), count - maxMemories + 100);
      dbPruneOldMemories(toDelete);
      logger.info('Memory', `Pruned ${toDelete} old memories (was ${count}, cap ${maxMemories})`);
    }

    const embedding = await getEmbedding(content);

    // Deduplication check
    if (await isDuplicate(embedding)) {
      logger.debug('Memory', `Skipped duplicate: "${content.slice(0, 60)}..."`);
      return;
    }

    const tier = significance >= mdThreshold ? 'curated' : 'observation';
    const embeddingBuf = float32ToBuffer(embedding);
    const rowId = insertMemory(
      content, embeddingBuf,
      meta.userId || null, meta.userName || null,
      meta.channelId || null, meta.category || 'fact',
      meta.metadata ? JSON.stringify(meta.metadata) : null,
      meta.guildId || null,
      tier, significance
    );

    // Write to Markdown files for high-significance memories
    if (significance >= mdThreshold) {
      appendDailyMemory(content, meta.category || 'fact');
      if (meta.userId && meta.userName) {
        appendUserMemory(meta.userId, meta.userName, content);
      }
    }

    logger.debug('Memory', `Stored: "${content.slice(0, 60)}..." [${meta.category || 'fact'}] tier=${tier} sig=${significance.toFixed(2)}`);

    // Check if consolidation needed for this user
    if (meta.userId) {
      const unconsolidated = countUserUnconsolidatedMemories(meta.userId);
      if (unconsolidated > 0 && unconsolidated % 10 === 0 && unconsolidated >= 15) {
        // Trigger consolidation asynchronously
        setImmediate(() => {
          try {
            const { consolidateUserMemories } = require('./memory-consolidation');
            consolidateUserMemories(meta.userId, meta.userName).catch(err =>
              logger.error('Memory', 'Auto-consolidation error:', err.message));
          } catch (_) {}
        });
      }
    }
  } catch (err) {
    logger.error('Memory', 'Store error:', err);
  }
}

async function searchMemory(query, limit = 5, minSimilarity = 0.65, guildId = null) {
  try {
    const queryEmbedding = await getEmbedding(query);
    // Pre-filter: last 90 days (configurable), max 500 candidates
    let mems = getRecentMemories(config.memorySearchDays, 500);

    // Scope by guild to prevent cross-server memory leaks
    if (guildId) {
      mems = mems.filter(m => !m.guild_id || m.guild_id === guildId);
    }

    const scored = [];
    for (const mem of mems) {
      if (!mem.embedding) continue;
      const memEmbedding = bufferToFloat32(mem.embedding);
      const sim = cosineSimilarity(queryEmbedding, memEmbedding);
      if (sim >= minSimilarity) {
        // Relevance decay: use last_accessed if available, else created_at
        const lastAccessed = mem.last_accessed && mem.last_accessed > 0
          ? mem.last_accessed
          : new Date(mem.timestamp).getTime();
        const daysSinceAccess = (Date.now() - lastAccessed) / 86400000;
        const decayFactor = Math.exp(-daysSinceAccess / 90); // 90-day half-life
        let decayedScore = sim * decayFactor;
        // Reinforcement boost: frequently accessed memories score higher
        const reinforcement = mem.reinforcement_count || 0;
        decayedScore *= (1 + 0.05 * Math.min(reinforcement, 10));
        scored.push({
          id: mem.id,
          content: mem.content,
          similarity: sim,
          decayedScore,
          category: mem.category,
          userId: mem.user_id,
          userName: mem.user_name,
          channelId: mem.channel_id,
          timestamp: mem.timestamp,
        });
      }
    }

    scored.sort((a, b) => b.decayedScore - a.decayedScore);
    return scored.slice(0, limit);
  } catch (err) {
    logger.error('Memory', 'Search error:', err);
    return [];
  }
}

/**
 * Hybrid search: combines vector cosine similarity with FTS5 keyword matching.
 * 70% vector score + 30% FTS5 rank (normalized).
 */
async function hybridSearch(query, limit = 5, minSimilarity = 0.55, guildId = null) {
  try {
    // Run both searches in parallel
    const [vectorResults, ftsResults] = await Promise.all([
      searchMemory(query, limit * 2, minSimilarity, guildId),
      Promise.resolve(searchFts(query, limit * 2)),
    ]);

    // Build a map keyed by content
    const merged = new Map();

    // Add vector results (includes id for touch tracking)
    for (const r of vectorResults) {
      merged.set(r.content, {
        ...r,
        vectorScore: r.decayedScore || r.similarity,
        ftsScore: 0,
      });
    }

    // Normalize FTS5 ranks (they're negative, lower = better)
    const ftsMin = ftsResults.length > 0 ? Math.min(...ftsResults.map(r => r.rank)) : 0;
    const ftsMax = ftsResults.length > 0 ? Math.max(...ftsResults.map(r => r.rank)) : 0;
    const ftsRange = ftsMax - ftsMin || 1;

    for (const r of ftsResults) {
      const normalizedFts = 1 - ((r.rank - ftsMin) / ftsRange); // 0-1, higher = better
      if (merged.has(r.content)) {
        merged.get(r.content).ftsScore = normalizedFts;
      } else {
        merged.set(r.content, {
          content: r.content,
          category: r.category,
          userName: r.user_name,
          similarity: 0.5, // default for FTS-only results
          vectorScore: 0,
          ftsScore: normalizedFts,
        });
      }
    }

    // Compute final scores and sort
    const results = [...merged.values()].map(r => ({
      ...r,
      finalScore: 0.7 * (r.vectorScore || 0) + 0.3 * (r.ftsScore || 0),
    }));

    results.sort((a, b) => b.finalScore - a.finalScore);
    const topResults = results.slice(0, limit);

    // Touch accessed memories (update last_accessed + reinforcement)
    for (const r of topResults) {
      if (r.id) {
        try { touchMemory(r.id); } catch (_) {}
      }
    }

    return topResults;
  } catch (err) {
    logger.error('Memory', 'Hybrid search error:', err);
    // Fallback to vector-only
    return searchMemory(query, limit, minSimilarity, guildId);
  }
}

/**
 * Batch extract facts from messages in one call.
 */
async function extractFacts(messages, channelId) {
  try {
    const transcript = messages
      .filter(m => m.role === 'user')
      .map(m => `${m.name || 'unknown'}: ${m.content}`)
      .join('\n');

    if (transcript.length < 20) return [];

    const res = await openai.chat.completions.create({
      model: config.miniModel,
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        {
          role: 'system',
          content: `Extract key facts, user preferences, and interesting topics from this Discord conversation. Return JSON array of objects with fields: "content" (the fact/learning), "category" (one of: fact, preference, interaction, topic), "userName" (who it's about, or null if general).

Only extract genuinely interesting or useful information. Skip greetings, filler, and trivial exchanges.

Return ONLY a valid JSON array, nothing else.`
        },
        { role: 'user', content: transcript }
      ],
    });

    const text = res.choices[0]?.message?.content || '[]';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const facts = JSON.parse(jsonMatch[0]);
    return facts.map(f => ({
      content: f.content,
      category: f.category || 'fact',
      userName: f.userName || null,
    }));
  } catch (err) {
    logger.error('Memory', 'Extract facts error:', err);
    return [];
  }
}

module.exports = { storeMemory, searchMemory, hybridSearch, extractFacts, getEmbedding, LRUCache, pruneByAge, isDuplicate, cosineSimilarity, float32ToBuffer, bufferToFloat32 };
