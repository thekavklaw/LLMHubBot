const { encoding_for_model } = require('tiktoken');

let enc;
function getEncoder() {
  if (!enc) enc = encoding_for_model('gpt-4o');
  return enc;
}

/**
 * Count tokens in a string.
 * @param {string} text
 * @returns {number}
 */
function countTokens(text) {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/**
 * Count total tokens in an OpenAI messages array.
 * Each message has ~4 token overhead (role, separators).
 * @param {Array} messages
 * @returns {number}
 */
function countMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    total += 4; // role + separators overhead
    if (typeof msg.content === 'string') {
      total += countTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'text') total += countTokens(part.text);
        else if (part.type === 'image_url') total += 85; // image token estimate
      }
    }
    if (msg.name) total += countTokens(msg.name);
  }
  total += 2; // priming
  return total;
}

module.exports = { countTokens, countMessagesTokens };
