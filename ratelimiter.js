/**
 * Rate limiter with sliding window counters and cooldowns.
 */

const USER_LIMIT = parseInt(process.env.RATE_LIMIT_USER || '5', 10);
const THREAD_LIMIT = 10;
const CHANNEL_LIMIT = 30;
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW || '30', 10) * 1000;
const CHANNEL_WINDOW_MS = 60 * 1000;
const COOLDOWN_MS = 60 * 1000;

// Maps: key → { timestamps: number[], cooldownUntil: number }
const userBuckets = new Map();
const channelBuckets = new Map();

function getBucket(map, key) {
  if (!map.has(key)) {
    map.set(key, { timestamps: [], cooldownUntil: 0 });
  }
  return map.get(key);
}

function pruneTimestamps(bucket, windowMs) {
  const cutoff = Date.now() - windowMs;
  bucket.timestamps = bucket.timestamps.filter(t => t > cutoff);
}

/**
 * Check if a message is allowed.
 * @returns {{ allowed: boolean, retryAfter: number }}
 */
function checkRateLimit(userId, channelId, isThread = false) {
  const now = Date.now();
  const userKey = `${userId}:${channelId}`;

  // ── User rate limit ──
  const userBucket = getBucket(userBuckets, userKey);

  // Check cooldown
  if (userBucket.cooldownUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((userBucket.cooldownUntil - now) / 1000) };
  }

  pruneTimestamps(userBucket, WINDOW_MS);
  const limit = isThread ? THREAD_LIMIT : USER_LIMIT;

  if (userBucket.timestamps.length >= limit) {
    // Enter cooldown
    userBucket.cooldownUntil = now + COOLDOWN_MS;
    console.log(`[RateLimit] User ${userId} hit limit in ${channelId}, cooldown 60s`);
    return { allowed: false, retryAfter: 60 };
  }

  // ── Channel rate limit (only for non-thread #gpt) ──
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

  userBucket.timestamps.push(now);
  return { allowed: true, retryAfter: 0 };
}

// ── Cleanup stale entries every 5 minutes ──
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of userBuckets) {
    pruneTimestamps(bucket, WINDOW_MS);
    if (bucket.timestamps.length === 0 && bucket.cooldownUntil < now) {
      userBuckets.delete(key);
    }
  }
  for (const [key, bucket] of channelBuckets) {
    pruneTimestamps(bucket, CHANNEL_WINDOW_MS);
    if (bucket.timestamps.length === 0) {
      channelBuckets.delete(key);
    }
  }
}, 5 * 60 * 1000);

module.exports = { checkRateLimit };
