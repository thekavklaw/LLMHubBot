/**
 * @module utils/cache
 * @description LRU Cache with TTL support. Used for caching tool results
 * (search, definitions, etc.) with automatic eviction and expiry.
 */
class LRUCache {
  constructor(maxSize = 100, defaultTTL = 900000) { // 15 min default
    this.cache = new Map();
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTL;
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() > entry.expires) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    // Move to end (most recent)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value, ttl) {
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expires: Date.now() + (ttl || this.defaultTTL) });
  }

  getStats() {
    return { size: this.cache.size, maxSize: this.maxSize, hits: this.hits, misses: this.misses };
  }
}

module.exports = LRUCache;
