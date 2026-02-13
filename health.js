/**
 * @module health
 * @description HTTP health endpoint for monitoring. Returns JSON with uptime,
 * memory usage, queue stats, error counts, and processing health on GET /health.
 */

const http = require('http');
const logger = require('./logger');

// Track last successful message processing
let lastProcessedAt = Date.now();
let recentErrors = 0;
let recentRequests = 0;

function recordProcessed() {
  lastProcessedAt = Date.now();
  recentRequests++;
}

function recordError() {
  recentErrors++;
}

// Reset error rate every minute
setInterval(() => {
  recentErrors = 0;
  recentRequests = 0;
}, 60000);

/**
 * HTTP health endpoint for monitoring.
 * @param {number} port - Port to listen on
 * @param {Function} getStats - Returns { queues, messagesProcessed, ... }
 * @returns {http.Server|null}
 */
function startHealthServer(port, getStats) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      try {
        const stats = getStats();
        const queueDepth = stats.queues?.main?.pending || 0;
        const timeSinceLastProcessed = Date.now() - lastProcessedAt;
        const errorRate = recentRequests > 0 ? recentErrors / recentRequests : 0;

        // Unhealthy if no processing for >5min AND queue has items
        const isHealthy = !(timeSinceLastProcessed > 300000 && queueDepth > 0);

        res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: isHealthy ? 'ok' : 'unhealthy',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          queues: stats.queues || {},
          messagesProcessed: stats.messagesProcessed || 0,
          errors: stats.errors || 0,
          lastProcessed: new Date(lastProcessedAt).toISOString(),
          lastProcessedAgo: Math.round(timeSinceLastProcessed / 1000),
          queueDepth,
          errorRate: Math.round(errorRate * 100) / 100,
          cache: stats.cache || {},
          debouncer: stats.debouncer || {},
          timestamp: new Date().toISOString(),
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: err.message }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  try {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn('Health', `Port ${port} already in use — health server disabled`);
      } else {
        logger.error('Health', `Health server error: ${err.message}`);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info('Health', `Health server listening on http://127.0.0.1:${port}/health`);
    });
  } catch (err) {
    logger.warn('Health', `Failed to start health server: ${err.message}`);
    return null;
  }

  return server;
}

module.exports = { startHealthServer, recordProcessed, recordError };
