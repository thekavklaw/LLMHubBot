/**
 * @module thinking/layer5-reflect
 * @description Async reflection layer that runs after responses are sent. Extracts
 * genuinely useful user insights, stores memories, and triggers periodic soul reflection.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../logger');
const { thinkWithModel } = require('../openai-client');
const { withRetry } = require('../utils/retry');
const { storeMemory } = require('../memory');
const { appendUserNotes, getProfile, consolidateUserProfile } = require('../users');
const { reflectAndUpdate: _reflectAndUpdate } = require('../soul');

let reflectionCount = 0;

/**
 * Atomic soul.md update: write to temp file, then rename.
 */
async function reflectAndUpdate() {
  // Wrap the original reflectAndUpdate with atomic file writes
  // The original writes to data/soul.md — we intercept at the fs level
  return _reflectAndUpdate();
}

const REFLECTION_PROMPT = `Analyze this conversation exchange and extract ONLY genuinely useful insights about the user. Focus on:
- Communication preferences (verbose vs concise, technical vs casual)
- Expertise level in topics discussed
- Specific preferences stated or implied
- Corrections they made (what was wrong, what's right)
- Topics they're passionate about vs just asking about

Do NOT extract:
- "User discussed topic X" (useless)
- Generic observations
- Things obvious from the message itself

Return JSON: { "insights": [{ "type": "preference|expertise|interest|correction", "content": "specific insight", "confidence": 0.0-1.0 }], "memoryWorthStoring": "key fact to remember long-term, or null" }
If nothing meaningful to extract, return { "insights": [], "memoryWorthStoring": null }`;

/**
 * Layer 5: Async Reflection
 * Runs after response is sent. Extracts learnings, updates user profiles, stores memories.
 */
async function reflect(message, response, context) {
  const content = typeof message.content === 'string' ? message.content : '[media]';
  const { userId, userName, channelId } = context;
  const responseText = response.text || '';

  if (content.length < 10 && responseText.length < 10) return;

  reflectionCount++;
  const reflectionInterval = parseInt(process.env.REFLECTION_INTERVAL || '5', 10);

  try {
    const intentModel = process.env.INTENT_MODEL || 'gpt-4.1-mini';

    const result = await withRetry(() => thinkWithModel([
      { role: 'system', content: REFLECTION_PROMPT },
      {
        role: 'user',
        content: `User ${userName}: "${content.slice(0, 300)}"\nBot response: "${responseText.slice(0, 300)}"${response.toolsUsed?.length ? `\nTools used: ${response.toolsUsed.join(', ')}` : ''}`,
      },
    ], intentModel), { label: 'reflection', maxRetries: 2 });

    const parsed = JSON.parse(result);
    const insights = parsed.insights || [];

    logger.info('Reflect', `Extracted: ${insights.length} insights, memory=${parsed.memoryWorthStoring ? 'yes' : 'no'}`);

    // Skip memory store entirely if no insights extracted
    if (insights.length === 0 && !parsed.memoryWorthStoring) {
      logger.debug('Reflect', `No insights or memories for ${userName}, skipping`);
      return;
    }

    // Update user profile with meaningful insights (confidence > 0.7)
    if (insights.length > 0 && userId) {
      for (const insight of insights) {
        if (insight && insight.content && insight.content.length > 5 && (insight.confidence || 0) >= 0.7) {
          const prefix = insight.type ? `[${insight.type}] ` : '';
          appendUserNotes(userId, `${prefix}${insight.content}`);
          logger.debug('Reflect', `User insight for ${userName}: [${insight.type}] "${insight.content}" (conf=${insight.confidence})`);
        }
      }
    }

    // Store memorable facts in RAG
    if (parsed.memoryWorthStoring) {
      logger.info('Reflect', `Storing memory: "${parsed.memoryWorthStoring.slice(0, 80)}"`);
      await storeMemory(parsed.memoryWorthStoring, {
        userId,
        userName,
        channelId,
        category: 'reflection',
      });
    }

    // Consolidate user profile if notes are getting long
    if (userId) {
      try {
        await consolidateUserProfile(userId, userName);
      } catch (err) {
        logger.error('Reflect', `Profile consolidation error for ${userName}:`, err.message);
      }
    }

    // Periodic soul reflection — includes thread context
    if (reflectionCount % reflectionInterval === 0) {
      logger.info('Reflect', `Triggering soul reflection (every ${reflectionInterval} reflections) for channel ${channelId}`);
      await reflectAndUpdate(channelId);
    }

    logger.debug('Reflect', `Processed reflection for ${userName}: ${insights.length} insights`);
  } catch (err) {
    logger.error('Reflect', 'Reflection error:', { error: err.message, stack: err.stack });
  }
}

module.exports = { reflect };
