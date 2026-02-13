const logger = require('../../logger');

module.exports = {
  name: 'tavily_search',
  description: 'Deep AI-powered web search with synthesized answers. Use for complex questions needing comprehensive answers.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      search_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'Search depth (basic or advanced)' },
      include_answer: { type: 'boolean', description: 'Whether to include a synthesized answer' },
    },
    required: ['query'],
  },
  async execute(args, context) {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error('TAVILY_API_KEY not configured');
    }

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: args.query,
        search_depth: args.search_depth || 'basic',
        include_answer: args.include_answer !== false,
        max_results: 5,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tavily API error: ${res.status} ${text}`);
    }

    const data = await res.json();
    return {
      answer: data.answer || null,
      results: (data.results || []).map(r => ({
        title: r.title || '',
        url: r.url || '',
        content: (r.content || '').substring(0, 500),
      })),
    };
  },
};
