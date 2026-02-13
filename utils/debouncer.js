/**
 * @module utils/debouncer
 * @description Message debouncer that coalesces rapid messages from the same
 * user+channel into a single processing call within a configurable time window.
 * Merges attachments from ALL messages in the batch.
 */
class MessageDebouncer {
  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
    this.pending = new Map(); // channelId:userId → { messages: [], timer }
  }

  /**
   * Add a message. If more messages arrive within windowMs, they're batched.
   * @param {Object} message - Discord message object
   * @param {Function} callback - (lastMessage, combinedContent, allAttachments) called after debounce window
   */
  add(message, callback) {
    const key = `${message.channel.id}:${message.author.id}`;

    if (this.pending.has(key)) {
      clearTimeout(this.pending.get(key).timer);
      this.pending.get(key).messages.push(message);
    } else {
      this.pending.set(key, { messages: [message] });
    }

    this.pending.get(key).timer = setTimeout(() => {
      const batch = this.pending.get(key);
      this.pending.delete(key);
      // Coalesce: combine all message contents into one
      const combined = batch.messages.map(m => m.content).join('\n');
      // Merge attachments from ALL messages, not just the last one
      const allAttachments = batch.messages.flatMap(m => m.attachments ? [...m.attachments.values()] : []);
      // Use last message as the "message" object (most recent context)
      const lastMessage = batch.messages[batch.messages.length - 1];
      callback(lastMessage, combined, allAttachments);
    }, this.windowMs);
  }

  /**
   * Check if a user+channel has pending debounced messages.
   */
  hasPending(channelId, userId) {
    return this.pending.has(`${channelId}:${userId}`);
  }

  getStats() {
    return { pendingBatches: this.pending.size };
  }
}

module.exports = MessageDebouncer;
