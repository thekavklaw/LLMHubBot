const config = require('./config');
const logger = require('./logger');

const USER_LIMIT = config.rateLimitUser;
const VIP_LIMIT = config.rateLimitVip;
const THREAD_LIMIT = config.rateLimitThread;
const CHANNEL_LIMIT = config.rateLimitChannel;
const WINDOW_MS = config.rateLimitWindow;
const CHANNEL_WINDOW_MS = config.rateLimitChannelWindow;
const COOLDOWN_MS = config.rateLimitCooldown;
const GLOBAL_PER_MINUTE = config.rateLimitGlobalPerMinute;

const VIP_ROLE_NAME = 'VIP';

const userBuckets = new Map();
const channelBuckets = new Map();

// Global API call tracking
const globalApiCalls = [];

function getBucket(map, key) {
  if (!map.has(key)) map.set(key, { timestamps: [], cooldownUntil: 0 });
  return map.get(key);
}

function pruneTimestamps(bucket, windowMs) {
  const cutoff = Date.now() - windowMs;
  bucket.timestamps = bucket.timestamps.filter(t => t > cutoff);
}

/**
 * Track a global API call. Returns false if over global limit.
 */
function trackGlobalApiCall() {
  const now = Date.now();
  const cutoff = now - 60000;
  // Remove old entries
  while (globalApiCalls.length > 0 && globalApiCalls[0] < cutoff) {
    globalApiCalls.shift();
  }
  if (globalApiCalls.length >= GLOBAL_PER_MINUTE) {
    return false;
  }
  globalApiCalls.push(now);
  return true;
}

/**
 * Check if a message is allowed.
 * @param {string} userId
 * @param {string} channelId
 * @param {boolean} isThread
 * @param {object} member - Discord GuildMember (optional, for role checks)
 * @returns {{ allowed: boolean, retryAfter: number }}
 */
function checkRateLimit(userId, channelId, isThread = false, member = null) {
  const now = Date.now();
  const userKey = `${userId}:${channelId}`;

  const userBucket = getBucket(userBuckets, userKey);

  if (userBucket.cooldownUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((userBucket.cooldownUntil - now) / 1000) };
  }

  pruneTimestamps(userBucket, WINDOW_MS);

  // Check for VIP role
  const isVip = member?.roles?.cache?.some(r => r.name === VIP_ROLE_NAME) || false;
  const limit = isThread ? THREAD_LIMIT : (isVip ? VIP_LIMIT : USER_LIMIT);

  if (userBucket.timestamps.length >= limit) {
    userBucket.cooldownUntil = now + COOLDOWN_MS;
    logger.info('RateLimit', `User ${userId} hit limit in ${channelId}, cooldown 60s`);
    return { allowed: false, retryAfter: 60 };
  }

  if (!isThread) {
    const chBucket = getBucket(channelBuckets, channelId);
    pruneTimestamps(chBucket, CHANNEL_WINDOW_MS);
    if (chBucket.timestamps.length >= CHANNEL_LIMIT) {
      const oldest = chBucket.timestamps[0];
      const retryAfter = Math.ceil((oldest + CHANNEL_WINDOW_MS - now) / 1000);
      return { allowed: false, retryAfter };
    }
    chBucket.timestamps.push(now);
  }

  // Global API limit check
  if (!trackGlobalApiCall()) {
    logger.warn('RateLimit', 'Global API limit reached (60/min)');
    return { allowed: false, retryAfter: 10 };
  }

  userBucket.timestamps.push(now);
  return { allowed: true, retryAfter: 0 };
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of userBuckets) {
    pruneTimestamps(bucket, WINDOW_MS);
    if (bucket.timestamps.length === 0 && bucket.cooldownUntil < now) userBuckets.delete(key);
  }
  for (const [key, bucket] of channelBuckets) {
    pruneTimestamps(bucket, CHANNEL_WINDOW_MS);
    if (bucket.timestamps.length === 0) channelBuckets.delete(key);
  }
}, 5 * 60 * 1000);

module.exports = { checkRateLimit, trackGlobalApiCall };
