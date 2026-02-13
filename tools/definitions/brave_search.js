const logger = require('../../logger');

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
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) {
      throw new Error('BRAVE_API_KEY not configured');
    }

    const count = Math.min(10, Math.max(1, args.count || 5));
    const params = new URLSearchParams({ q: args.query, count: String(count) });
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!res.ok) {
      throw new Error(`Brave API error: ${res.status}`);
    }

    const data = await res.json();
    const results = (data.web?.results || []).slice(0, count).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
    }));

    return results.length > 0 ? results : [{ title: 'No results', url: '', snippet: 'No results found.' }];
  },
};
