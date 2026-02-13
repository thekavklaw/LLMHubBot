const logger = require('./logger');

class TaskQueue {
  constructor(concurrency = 10) {
    this.concurrency = concurrency;
    this.processing = 0;
    this.queued = [];
    this.completed = 0;
    this.errors = 0;
  }

  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queued.push({ task, resolve, reject });
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
      queued: this.queued.length,
      processing: this.processing,
      completed: this.completed,
      errors: this.errors,
    };
  }
}

module.exports = TaskQueue;
