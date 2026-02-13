/**
 * @module config
 * @description Central configuration for the LLMHub bot. Reads from environment
 * variables with sensible defaults. Exported as a frozen object.
 */

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

  // Thinking layer
  enableThinking: process.env.ENABLE_THINKING !== 'false',
  thinkingModel: process.env.THINKING_MODEL || 'gpt-4.1-mini',

  // Image generation
  enableImageGeneration: process.env.ENABLE_IMAGE_GENERATION !== 'false',
  imageModel: process.env.IMAGE_MODEL || 'gpt-image-1',
  maxImagesPerUserPerHour: parseInt(process.env.MAX_IMAGES_PER_USER_PER_HOUR || '10', 10),

  // Agent loop
  enableAgentLoop: process.env.ENABLE_AGENT_LOOP === 'true',
  maxAgentIterations: parseInt(process.env.MAX_AGENT_ITERATIONS || '10', 10),
  agentLoopTimeout: parseInt(process.env.AGENT_LOOP_TIMEOUT || '60000', 10),
  tavilyApiKey: process.env.TAVILY_API_KEY || '',

  // 5-Layer Thinking
  thinkingLayersEnabled: process.env.THINKING_LAYERS_ENABLED !== 'false',
  gateModel: process.env.GATE_MODEL || 'gpt-4.1-mini',
  intentModel: process.env.INTENT_MODEL || 'gpt-4.1-mini',
  reflectionIntervalLayers: parseInt(process.env.REFLECTION_INTERVAL || '5', 10),

  // Guard rails
  allowedGuildId: process.env.ALLOWED_GUILD_ID || '',
  allowedChannelIds: (process.env.ALLOWED_CHANNEL_IDS || '').split(',').filter(Boolean),

  // Feature flags
  features: {
    memory: true,
    moderation: true,
    relevanceCheck: true,
    soulReflection: true,
  },
};

module.exports = Object.freeze(config);
