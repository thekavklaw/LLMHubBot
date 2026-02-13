/**
 * @module health
 * @description HTTP health endpoint for monitoring. Returns JSON with uptime,
 * memory usage, queue stats, and error counts on GET /health.
 */

const http = require('http');
const logger = require('./logger');

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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          queues: stats.queues || {},
          messagesProcessed: stats.messagesProcessed || 0,
          errors: stats.errors || 0,
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

module.exports = { startHealthServer };
