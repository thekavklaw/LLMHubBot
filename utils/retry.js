/**
 * @module utils/retry
 * @description Retry wrapper with exponential backoff. Respects 429 Retry-After
 * headers and skips retries on non-retryable client errors.
 */

const logger = require('../logger');

/**
 * Retry wrapper with exponential backoff.
 * Respects 429 Retry-After headers.
 * Does NOT retry on 4xx client errors (except 429).
 */
async function withRetry(fn, {
  maxRetries = 3,
  backoffMs = 1000,
  backoffMultiplier = 2,
  retryOn,
  label = 'operation',
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Only retry on specific error types if retryOn provided
      if (retryOn && !retryOn(err)) throw err;

      // Don't retry on 4xx client errors (except 429 rate limit)
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;

      // Calculate delay — respect Retry-After header for 429s
      let delay = backoffMs * Math.pow(backoffMultiplier, attempt - 1);
      if (err.status === 429) {
        const retryAfter = err.headers?.get?.('retry-after') || err.headers?.['retry-after'];
        if (retryAfter) {
          const retryMs = parseInt(retryAfter, 10) * 1000;
          if (!isNaN(retryMs) && retryMs > 0) delay = Math.max(delay, retryMs);
        }
        // Use longer backoff for rate limits
        delay = Math.max(delay, 2000 * attempt);
      }

      // Add jitter to prevent thundering herd (0-30%)
      const jitter = Math.random() * delay * 0.3;
      const totalDelay = delay + jitter;

      logger.warn(`[Retry] ${label} attempt ${attempt}/${maxRetries} failed, retrying in ${Math.round(totalDelay)}ms`, { error: err.message });

      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, totalDelay));
      }
    }
  }
  throw lastError;
}

module.exports = { withRetry };
