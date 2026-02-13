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

const { updateUserTopics, getUserProfile } = require('../db');

let reflectionCount = 0;

// Patterns for trivial messages that should skip reflection entirely
const SKIP_PATTERNS = /^(hi|hello|hey|sup|yo|hola|gm|gn|ok|okay|k|thanks|thank you|thx|ty|lol|lmao|haha|heh|nice|cool|yep|yea|yeah|nah|no|yes|nope|brb|gtg|wb|gg|rip|f|w|l|bet|fr|ong|ngl|idk|idc|smh|imo|tbh|fyi)[\s!.?]*$/i;
const COMMAND_PATTERN = /^[!/]\w+/;

/**
 * Atomic soul.md update: write to temp file, then rename.
 */
async function reflectAndUpdate() {
  return _reflectAndUpdate();
}

const REFLECTION_PROMPT = `Analyze this conversation exchange and extract ONLY genuinely useful insights about the user. Focus on:
- Communication preferences (verbose vs concise, technical vs casual)
- Expertise level in topics discussed
- Specific preferences stated or implied
- Corrections they made (what was wrong, what's right)
- Topics they're passionate about vs just asking about

Also rate the SIGNIFICANCE of this exchange (0.0-1.0):
- 0.0-0.3: Casual/filler (greetings, acknowledgments, "ok", "thanks", simple Q&A)
- 0.4-0.6: Informational but routine (lookup requests, basic questions answered)
- 0.7-0.8: Contains useful preference, fact, or correction worth remembering
- 0.9-1.0: Critical personal info, strong emotion, explicit "remember this", or correction of prior knowledge

Score guidelines:
- "remember this", "I like X", "I work at Y" = 0.9+
- Corrections ("no, actually...") = 0.95
- Simple Q&A the bot answered = 0.3
- "ok", "thanks", "haha" = 0.1

Do NOT extract:
- "User discussed topic X" (useless)
- Generic observations
- Things obvious from the message itself

Return JSON: { "significance": 0.0-1.0, "insights": [{ "type": "preference|expertise|interest|correction", "content": "specific insight", "confidence": 0.0-1.0 }], "memoryWorthStoring": "key fact to remember long-term, or null", "topics": ["keyword1", "keyword2"] }
If nothing meaningful to extract, return { "significance": 0.1, "insights": [], "memoryWorthStoring": null, "topics": [] }`;

/**
 * Layer 5: Async Reflection
 * Runs after response is sent. Extracts learnings, updates user profiles, stores memories.
 */
async function reflect(message, response, context) {
  const content = typeof message.content === 'string' ? message.content : '[media]';
  const { userId, userName, channelId } = context;
  const responseText = response.text || '';

  // Selective reflection: skip trivial exchanges
  if (content.length < 10 && responseText.length < 50) return;
  if (SKIP_PATTERNS.test(content.trim())) {
    logger.debug('Reflect', `Skipping trivial message from ${userName}: "${content.slice(0, 30)}"`);
    return;
  }
  if (COMMAND_PATTERN.test(content.trim())) {
    logger.debug('Reflect', `Skipping command from ${userName}: "${content.slice(0, 30)}"`);
    return;
  }

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
    const significance = typeof parsed.significance === 'number' ? parsed.significance : 0.5;
    const topics = Array.isArray(parsed.topics) ? parsed.topics : [];

    logger.info('Reflect', `Extracted: ${insights.length} insights, sig=${significance.toFixed(2)}, topics=${topics.length}, memory=${parsed.memoryWorthStoring ? 'yes' : 'no'}`);

    // Skip memory store entirely if low significance and no insights
    if (significance < 0.5 && insights.length === 0 && !parsed.memoryWorthStoring) {
      logger.debug('Reflect', `Low significance (${significance.toFixed(2)}) for ${userName}, skipping`);
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

    // Update topics in user profile
    if (topics.length > 0 && userId) {
      try {
        const profile = getUserProfile(userId);
        if (profile) {
          let existingTopics = [];
          try { existingTopics = JSON.parse(profile.topics || '[]'); } catch (_) {}
          const merged = [...new Set([...existingTopics, ...topics])].slice(0, 50); // cap at 50 topics
          updateUserTopics(userId, JSON.stringify(merged));
          logger.debug('Reflect', `Updated topics for ${userName}: +${topics.length} → ${merged.length} total`);
        }
      } catch (err) {
        logger.error('Reflect', `Topics update error for ${userName}:`, err.message);
      }
    }

    // Store memorable facts in RAG with significance
    if (parsed.memoryWorthStoring && significance >= 0.5) {
      logger.info('Reflect', `Storing memory (sig=${significance.toFixed(2)}): "${parsed.memoryWorthStoring.slice(0, 80)}"`);
      await storeMemory(parsed.memoryWorthStoring, {
        userId,
        userName,
        channelId,
        category: 'reflection',
        significance,
        guildId: context.guildId,
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
