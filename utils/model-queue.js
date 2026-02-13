const logger = require('../logger');

/**
 * Priority-aware task queue with max depth.
 * Higher priority values are processed first.
 */
class PriorityTaskQueue {
  constructor(concurrency = 10, maxDepth = 50) {
    this.concurrency = concurrency;
    this.maxDepth = maxDepth;
    this.processing = 0;
    this.queued = []; // sorted by priority (highest first)
    this.completed = 0;
    this.errors = 0;
  }

  /**
   * @param {Function} task - async function to execute
   * @param {number} priority - 0 (lowest) to 3 (highest)
   * @returns {Promise} resolves with task result, or rejects if queue full
   */
  enqueue(task, priority = 0) {
    if (this.queued.length >= this.maxDepth) {
      return Promise.reject(new Error('QUEUE_FULL'));
    }

    return new Promise((resolve, reject) => {
      // Insert in priority order (highest first)
      const entry = { task, resolve, reject, priority };
      let inserted = false;
      for (let i = 0; i < this.queued.length; i++) {
        if (this.queued[i].priority < priority) {
          this.queued.splice(i, 0, entry);
          inserted = true;
          break;
        }
      }
      if (!inserted) this.queued.push(entry);
      this._process();
    });
  }

  async _process() {
    if (this.processing >= this.concurrency || this.queued.length === 0) return;

    this.processing++;
    const { task, resolve, reject } = this.queued.shift();

    try {
      const result = await task();
      this.completed++;
      resolve(result);
    } catch (err) {
      this.errors++;
      reject(err);
    } finally {
      this.processing--;
      this._process();
    }
  }

  getStats() {
    return {
      pending: this.queued.length,
      active: this.processing,
      completed: this.completed,
      errors: this.errors,
      maxDepth: this.maxDepth,
    };
  }
}

/**
 * Per-model queue system.
 * Routes tasks to the appropriate queue based on model name.
 */
class ModelQueue {
  constructor(config = {}) {
    this.queues = {
      main: new PriorityTaskQueue(config.mainConcurrency || 8, config.mainMaxDepth || 50),
      mini: new PriorityTaskQueue(config.miniConcurrency || 15, config.miniMaxDepth || 100),
      image: new PriorityTaskQueue(config.imageConcurrency || 3, config.imageMaxDepth || 10),
      moderation: new PriorityTaskQueue(config.modConcurrency || 20, config.modMaxDepth || 100),
    };
  }

  /**
   * Enqueue a task to the appropriate model queue.
   * @param {string} model - model name (used to route to queue)
   * @param {Function} fn - async function to execute
   * @param {number} priority - 0-3
   * @returns {Promise}
   */
  async enqueue(model, fn, priority = 0) {
    const queueName = this.getQueueName(model);
    return this.queues[queueName].enqueue(fn, priority);
  }

  getQueueName(model) {
    if (!model) return 'main';
    if (model.includes('image')) return 'image';
    if (model.includes('mini')) return 'mini';
    if (model.includes('moderation')) return 'moderation';
    return 'main';
  }

  getStats() {
    const stats = {};
    for (const [name, queue] of Object.entries(this.queues)) {
      stats[name] = queue.getStats();
    }
    return stats;
  }

  /**
   * Check if a specific queue is full.
   */
  isQueueFull(model) {
    const queueName = this.getQueueName(model);
    const q = this.queues[queueName];
    return q.queued.length >= q.maxDepth;
  }
}

module.exports = { ModelQueue, PriorityTaskQueue };
