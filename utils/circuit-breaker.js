/**
 * @module utils/circuit-breaker
 * @description Circuit breaker pattern for external service calls (OpenAI, etc.).
 * Prevents cascading failures by temporarily stopping calls after repeated failures.
 */

const logger = require('../logger');

class CircuitBreaker {
  /**
   * @param {string} name - Identifier for logging
   * @param {Object} opts
   * @param {number} opts.failureThreshold - Failures before opening (default 3)
   * @param {number} opts.resetTimeout - Ms before trying again (default 30000)
   */
  constructor(name, { failureThreshold = 3, resetTimeout = 30000 } = {}) {
    this.name = name;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.failureThreshold = failureThreshold;
    this.resetTimeout = resetTimeout;
    this.nextAttempt = 0;
  }

  /**
   * Execute a function through the circuit breaker.
   * @param {Function} fn - Async function to execute
   * @returns {*} Result of fn()
   */
  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error(`Circuit breaker ${this.name} is OPEN — retry after ${Math.ceil((this.nextAttempt - Date.now()) / 1000)}s`);
      }
      this.state = 'HALF_OPEN';
      logger.info(`[CircuitBreaker] ${this.name} → HALF_OPEN (testing)`);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      logger.info(`[CircuitBreaker] ${this.name} → CLOSED (recovered)`);
    }
    this.failures = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failures++;
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.resetTimeout;
      logger.warn(`[CircuitBreaker] ${this.name} → OPEN after ${this.failures} failures (reset in ${this.resetTimeout / 1000}s)`);
    }
  }

  /** Get current state info. */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      nextAttempt: this.state === 'OPEN' ? this.nextAttempt : null,
    };
  }
}

module.exports = { CircuitBreaker };
