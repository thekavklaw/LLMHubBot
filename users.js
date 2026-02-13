const { upsertUserProfile, getUserProfile, updateUserNotes, updateUserPreferences, updateUserTopics } = require('./db');

/**
 * Track a user message — creates or updates their profile.
 */
function trackUser(userId, userName, displayName) {
  upsertUserProfile(userId, userName, displayName || userName);
}

/**
 * Get a user's profile, or null if not found.
 */
function getProfile(userId) {
  return getUserProfile(userId);
}

/**
 * Append notes to a user's personality_notes field.
 * @param {string} userId
 * @param {string} newNotes - Text to append
 */
function appendUserNotes(userId, newNotes) {
  const profile = getUserProfile(userId);
  if (!profile) return;

  const existing = profile.personality_notes || '';
  // Avoid duplicates by checking if note already exists
  if (existing.includes(newNotes.trim())) return;

  const separator = existing ? '\n' : '';
  const timestamp = new Date().toISOString().slice(0, 10);
  updateUserNotes(userId, existing + separator + `[${timestamp}] ${newNotes.trim()}`);
}

/**
 * Update user notes from extracted facts.
 * @param {Array} facts - [{content, category, userName}]
 * @param {Map|object} userMap - userName -> userId mapping
 */
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

/**
 * Format a user profile for inclusion in system prompt.
 */
function formatProfileForPrompt(userId) {
  const profile = getProfile(userId);
  if (!profile) return '';

  const parts = [];
  parts.push(`User: ${profile.display_name || profile.user_name} (${profile.message_count} messages)`);
  if (profile.personality_notes) {
    parts.push(`Known about them:\n${profile.personality_notes}`);
  }
  return parts.join('\n');
}

module.exports = { trackUser, getProfile, appendUserNotes, updateProfilesFromFacts, formatProfileForPrompt };
