const { searchMemory } = require('../../memory');

module.exports = {
  name: 'recall',
  description: 'Search long-term memory for previously stored information. Use when the user asks about something you might have been told before.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for in memory' },
      limit: { type: 'number', description: 'Max results to return (default 5)' },
    },
    required: ['query'],
  },
  async execute(args, context) {
    const limit = Math.min(20, Math.max(1, args.limit || 5));
    const results = await searchMemory(args.query, limit, 0.65, context?.guildId);
    if (!results || results.length === 0) {
      return { found: false, message: 'No matching memories found.', results: [] };
    }
    return {
      found: true,
      count: results.length,
      results: results.map(r => ({
        content: r.content,
        category: r.category || 'fact',
        timestamp: r.timestamp,
        similarity: r.similarity ? r.similarity.toFixed(3) : null,
      })),
    };
  },
};
