const { upsertUserProfile, getUserProfile, updateUserNotes, updateUserPreferences, updateUserTopics } = require('./db');
const config = require('./config');

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

module.exports = { trackUser, getProfile, appendUserNotes, updateProfilesFromFacts, formatProfileForPrompt };
