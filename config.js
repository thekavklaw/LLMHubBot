require('dotenv').config();

const config = {
  // Discord
  discordToken: process.env.DISCORD_TOKEN,
  appId: process.env.APP_ID,
  guildId: process.env.GUILD_ID,
  gptChannelId: process.env.GPT_CHANNEL_ID,

  // OpenAI
  openaiApiKey: process.env.OPENAI_API_KEY,
  model: process.env.MODEL || 'gpt-5.2',
  miniModel: process.env.MINI_MODEL || 'gpt-4.1-mini',
  temperature: parseFloat(process.env.TEMPERATURE || '0.8'),
  maxTokens: parseInt(process.env.MAX_TOKENS || '1000', 10),

  // Rate limits
  rateLimitUser: parseInt(process.env.RATE_LIMIT_USER || '5', 10),
  rateLimitVip: parseInt(process.env.RATE_LIMIT_VIP || '15', 10),
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '30', 10) * 1000,
  rateLimitThread: 10,
  rateLimitChannel: 30,
  rateLimitChannelWindow: 60 * 1000,
  rateLimitCooldown: 60 * 1000,
  rateLimitGlobalPerMinute: 60,

  // Concurrency
  maxConcurrentApi: 10,
  apiTimeoutMs: 30000,

  // Memory
  memoryMaxRows: 10000,
  memoryPrunePercent: 0.2,
  memorySearchDays: 30,
  embeddingCacheSize: 100,
  factExtractionInterval: 15,
  reflectionInterval: 50,

  // Context
  contextWindowSize: 20,
  summaryInterval: 10,

  // Moderation
  moderationEnabled: process.env.MODERATION_ENABLED !== 'false',

  // DB
  dbBusyTimeout: 5000,
  dbMaxSizeMb: 100,

  // User cache
  userCacheTtlMs: 5 * 60 * 1000,

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  logMaxSizeBytes: 5 * 1024 * 1024,
  logMaxFiles: 3,

  // Feature flags
  features: {
    memory: true,
    moderation: true,
    relevanceCheck: true,
    soulReflection: true,
  },
};

module.exports = Object.freeze(config);
