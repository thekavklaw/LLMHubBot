/**
 * @module tools/definitions/brave_search
 * @description Web search tool using Brave Search API. Falls back to Tavily on failure.
 */

const logger = require('../../logger');
const { withRetry } = require('../../utils/retry');
const LRUCache = require('../../utils/cache');

const searchCache = new LRUCache(100, 900000); // 15 min TTL

module.exports = {
  name: 'brave_search',
  description: 'Search the web using Brave Search for quick factual lookups, current events, or any question needing up-to-date information.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      count: { type: 'number', description: 'Number of results (1-10)' },
    },
    required: ['query'],
  },
  async execute(args, context) {
    try {
      return await doBraveSearch(args);
    } catch (err) {
      logger.warn('BraveSearch', `Failed, falling back to Tavily: ${err.message}`);
      if (context && context.registry) {
        const tavily = context.registry.getTool('tavily_search');
        if (tavily) return tavily.execute(args, context);
      }
      throw err;
    }
  },
  getCache() { return searchCache; },
};

/**
 * Perform Brave Search API call.
 * @param {Object} args - { query: string, count?: number }
 * @returns {Promise<Array>} Search results
 */
async function doBraveSearch(args) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error('BRAVE_API_KEY not configured');

  const count = Math.min(10, Math.max(1, args.count || 5));
  const cacheKey = `brave:${args.query}:${count}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    logger.info('BraveSearch', `Cache hit for "${args.query}"`);
    return cached;
  }

  const params = new URLSearchParams({ q: args.query, count: String(count) });
  const res = await withRetry(() => fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  }), { label: 'brave-search' });

  if (!res.ok) throw new Error(`Brave API error: ${res.status}`);

  const data = await res.json();
  const results = (data.web?.results || []).slice(0, count).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.description || '',
  }));

  const finalResults = results.length > 0 ? results : [{ title: 'No results', url: '', snippet: 'No results found.' }];
  searchCache.set(cacheKey, finalResults);
  return finalResults;
}
