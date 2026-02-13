const OpenAI = require('openai');
const { insertMemory, getAllMemories } = require('./db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Get embedding vector for text using OpenAI text-embedding-3-small.
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
async function getEmbedding(text) {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000),
  });
  return new Float32Array(res.data[0].embedding);
}

/**
 * Convert Float32Array to Buffer for SQLite BLOB storage.
 */
function float32ToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Convert Buffer back to Float32Array.
 */
function bufferToFloat32(buf) {
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(ab);
}

/**
 * Cosine similarity between two Float32Arrays.
 */
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
 * Store a memory with its embedding.
 * @param {string} content - The memory content
 * @param {object} meta - { userId, userName, channelId, category, metadata }
 */
async function storeMemory(content, meta = {}) {
  try {
    const embedding = await getEmbedding(content);
    const embeddingBuf = float32ToBuffer(embedding);
    insertMemory(
      content,
      embeddingBuf,
      meta.userId || null,
      meta.userName || null,
      meta.channelId || null,
      meta.category || 'fact',
      meta.metadata ? JSON.stringify(meta.metadata) : null
    );
    console.log(`[Memory] Stored: "${content.slice(0, 60)}..." [${meta.category || 'fact'}]`);
  } catch (err) {
    console.error('[Memory] Store error:', err.message);
  }
}

/**
 * Search memories by semantic similarity.
 * @param {string} query
 * @param {number} limit
 * @param {number} minSimilarity
 * @returns {Promise<Array<{content, similarity, category, userId, userName, timestamp}>>}
 */
async function searchMemory(query, limit = 5, minSimilarity = 0.7) {
  try {
    const queryEmbedding = await getEmbedding(query);
    const allMems = getAllMemories();

    const scored = [];
    for (const mem of allMems) {
      if (!mem.embedding) continue;
      const memEmbedding = bufferToFloat32(mem.embedding);
      const sim = cosineSimilarity(queryEmbedding, memEmbedding);
      if (sim >= minSimilarity) {
        scored.push({
          content: mem.content,
          similarity: sim,
          category: mem.category,
          userId: mem.user_id,
          userName: mem.user_name,
          channelId: mem.channel_id,
          timestamp: mem.timestamp,
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  } catch (err) {
    console.error('[Memory] Search error:', err.message);
    return [];
  }
}

/**
 * Extract key facts from recent messages using GPT-4o-mini.
 * @param {Array} messages - [{role, content, name}]
 * @param {string} channelId
 * @returns {Promise<Array<{content, category, userId, userName}>>}
 */
async function extractFacts(messages, channelId) {
  try {
    const transcript = messages
      .filter(m => m.role === 'user')
      .map(m => `${m.name || 'unknown'}: ${m.content}`)
      .join('\n');

    if (transcript.length < 20) return [];

    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
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
    console.error('[Memory] Extract facts error:', err.message);
    return [];
  }
}

module.exports = { storeMemory, searchMemory, extractFacts, getEmbedding };
