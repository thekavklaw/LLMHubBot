const { upsertUserProfile, getUserProfile, updateUserNotes, updateUserPreferences, updateUserTopics } = require('./db');
const config = require('./config');
const logger = require('./logger');

// ── User profile cache (Map with TTL) ──
const profileCache = new Map();

function getCachedProfile(userId) {
  const entry = profileCache.get(userId);
  if (entry && Date.now() - entry.ts < config.userCacheTtlMs) return entry.data;
  return null;
}

function setCachedProfile(userId, data) {
  profileCache.set(userId, { data, ts: Date.now() });
  // Prune cache if too large
  if (profileCache.size > 500) {
    const cutoff = Date.now() - config.userCacheTtlMs;
    for (const [k, v] of profileCache) {
      if (v.ts < cutoff) profileCache.delete(k);
    }
  }
}

function trackUser(userId, userName, displayName) {
  upsertUserProfile(userId, userName, displayName || userName);
  // Invalidate cache
  profileCache.delete(userId);
}

function getProfile(userId) {
  const cached = getCachedProfile(userId);
  if (cached) return cached;
  const profile = getUserProfile(userId);
  if (profile) setCachedProfile(userId, profile);
  return profile;
}

function appendUserNotes(userId, newNotes) {
  const profile = getProfile(userId);
  if (!profile) return;
  const existing = profile.personality_notes || '';
  if (existing.includes(newNotes.trim())) return;
  const separator = existing ? '\n' : '';
  const timestamp = new Date().toISOString().slice(0, 10);
  updateUserNotes(userId, existing + separator + `[${timestamp}] ${newNotes.trim()}`);
  profileCache.delete(userId);
}

function updateProfilesFromFacts(facts, userMap) {
  for (const fact of facts) {
    if (!fact.userName) continue;
    const userId = userMap instanceof Map ? userMap.get(fact.userName) : userMap[fact.userName];
    if (!userId) continue;
    if (fact.category === 'preference') {
      appendUserNotes(userId, `Preference: ${fact.content}`);
    } else if (fact.category === 'topic') {
      appendUserNotes(userId, `Interested in: ${fact.content}`);
    } else {
      appendUserNotes(userId, fact.content);
    }
  }
}

function formatProfileForPrompt(userId) {
  const profile = getProfile(userId);
  if (!profile) return '';
  const parts = [];
  parts.push(`User: ${profile.display_name || profile.user_name} (${profile.message_count} messages)`);
  if (profile.personality_notes) parts.push(`Known about them:\n${profile.personality_notes}`);
  return parts.join('\n');
}

/**
 * Consolidate user profile notes when they exceed 50 entries.
 * Calls gpt-4.1-mini to summarize into a concise profile.
 */
async function consolidateUserProfile(userId, userName) {
  const profile = getProfile(userId);
  if (!profile || !profile.personality_notes) return;

  const notes = profile.personality_notes;
  const noteCount = notes.split('\n').filter(l => l.trim()).length;

  if (noteCount < 50) return;

  logger.info('Users', `Consolidating ${noteCount} notes for ${userName} (${userId})`);

  try {
    const { thinkWithModel } = require('./openai-client');
    const { withRetry } = require('./utils/retry');

    const result = await withRetry(() => thinkWithModel([
      {
        role: 'system',
        content: `Summarize these personality notes about a user into a concise profile (max 500 chars). Keep only the most important and current preferences, expertise areas, and communication style. Return JSON: { "profile": "consolidated profile text" }`,
      },
      {
        role: 'user',
        content: `User: ${userName}\nNotes:\n${notes}`,
      },
    ], 'gpt-4.1-mini'), { label: 'profile-consolidation', maxRetries: 2 });

    const parsed = JSON.parse(result);
    if (parsed.profile && parsed.profile.length > 10) {
      const timestamp = new Date().toISOString().slice(0, 10);
      updateUserNotes(userId, `[${timestamp}] [consolidated] ${parsed.profile}`);
      profileCache.delete(userId);
      logger.info('Users', `Consolidated ${noteCount} notes for ${userName} → ${parsed.profile.length} chars`);
    }
  } catch (err) {
    logger.error('Users', `Consolidation failed for ${userName}:`, err.message);
  }
}

module.exports = { trackUser, getProfile, appendUserNotes, updateProfilesFromFacts, formatProfileForPrompt, consolidateUserProfile };
