/**
 * @module utils/errors
 * @description User-friendly error messages with reference IDs for debugging.
 * Maps technical errors to human-readable Discord responses.
 */

const logger = require('../logger');

const USER_ERRORS = {
  rate_limit: "I'm getting rate limited by OpenAI. Give me a minute and try again! ⏳",
  timeout: "That took too long — my brain timed out. Try a simpler request? 🤔",
  api_error: "Something went wrong on my end. Try again in a moment! 🔧",
  moderation: "I can't help with that particular request. Try rephrasing?",
  queue_full: "I'm juggling too many conversations right now. Try again shortly! 🕐",
  unknown: "Something unexpected happened. Try again? 🤷",
};

/**
 * Generate a short reference ID for error tracking.
 * @returns {string} 6-char alphanumeric reference
 */
function generateRefId() {
  return Math.random().toString(36).substr(2, 6);
}

/**
 * Determine error severity.
 * @param {Error} err
 * @returns {'recoverable'|'serious'}
 */
function errorSeverity(err) {
  if (!err) return 'serious';
  if (err.message === 'QUEUE_FULL') return 'recoverable';
  if (err.status === 429) return 'recoverable';
  if (err.code === 'ETIMEDOUT' || err.message === 'TIMEOUT') return 'recoverable';
  if (err.status >= 500) return 'serious';
  return 'serious';
}

/**
 * Get embed color based on error severity.
 * @param {'recoverable'|'serious'} severity
 * @returns {number} Discord embed color
 */
function errorColor(severity) {
  return severity === 'recoverable' ? 0xFEE75C : 0xED4245; // amber vs red
}

/**
 * Convert a technical error into a user-friendly message with a reference ID.
 * @param {Error} err - The error to convert
 * @returns {string} A friendly error message suitable for Discord
 */
function friendlyError(err) {
  const refId = generateRefId();
  let baseMessage;

  if (!err) {
    baseMessage = USER_ERRORS.unknown;
  } else if (err.message === 'QUEUE_FULL') {
    baseMessage = USER_ERRORS.queue_full;
  } else if (err.status === 429) {
    baseMessage = USER_ERRORS.rate_limit;
  } else if (err.code === 'ETIMEDOUT' || err.message === 'TIMEOUT' || err.message?.includes('timeout') || err.message?.includes('timed out')) {
    baseMessage = USER_ERRORS.timeout;
  } else if (err.status >= 500) {
    baseMessage = USER_ERRORS.api_error;
  } else if (err.message?.includes('moderation') || err.message?.includes('flagged')) {
    baseMessage = USER_ERRORS.moderation;
  } else {
    baseMessage = USER_ERRORS.unknown;
  }

  // Log refId with full error for debugging
  logger.error('ErrorRef', `ref:${refId}`, err || new Error('unknown'));

  return `${baseMessage}\nIf this keeps happening, mention ref: \`${refId}\``;
}

module.exports = { USER_ERRORS, friendlyError, generateRefId, errorSeverity, errorColor };
