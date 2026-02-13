const { storeMemory } = require('../../memory');

module.exports = {
  name: 'remember',
  description: 'Explicitly store a piece of information in long-term memory for later recall. Use when the user asks you to remember something.',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The information to remember' },
      category: { type: 'string', enum: ['fact', 'preference', 'topic'], description: 'Category of information' },
    },
    required: ['content'],
  },
  async execute(args, context) {
    const category = args.category || 'fact';
    await storeMemory(args.content, {
      userId: context?.userId,
      userName: context?.userName,
      channelId: context?.channelId,
      category,
    });
    return { stored: true, content: args.content, category };
  },
};
