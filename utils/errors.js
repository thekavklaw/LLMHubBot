/**
 * @module utils/errors
 * @description User-friendly error messages for common failure modes.
 * Maps technical errors to human-readable Discord responses.
 */

const USER_ERRORS = {
  rate_limit: "I'm getting rate limited by OpenAI. Give me a minute and try again! ⏳",
  timeout: "That took too long — my brain timed out. Try a simpler request? 🤔",
  api_error: "Something went wrong on my end. Try again in a moment! 🔧",
  moderation: "I can't respond to that. Let's keep things appropriate! 🛡️",
  queue_full: "I'm juggling too many conversations right now. Try again shortly! 🕐",
  unknown: "Something unexpected happened. Try again? 🤷",
};

/**
 * Convert a technical error into a user-friendly message.
 * @param {Error} err - The error to convert
 * @returns {string} A friendly error message suitable for Discord
 */
function friendlyError(err) {
  if (!err) return USER_ERRORS.unknown;
  if (err.message === 'QUEUE_FULL') return USER_ERRORS.queue_full;
  if (err.status === 429) return USER_ERRORS.rate_limit;
  if (err.code === 'ETIMEDOUT' || err.message === 'TIMEOUT' || err.message?.includes('timeout') || err.message?.includes('timed out')) return USER_ERRORS.timeout;
  if (err.status >= 500) return USER_ERRORS.api_error;
  if (err.message?.includes('moderation') || err.message?.includes('flagged')) return USER_ERRORS.moderation;
  return USER_ERRORS.unknown;
}

module.exports = { USER_ERRORS, friendlyError };
