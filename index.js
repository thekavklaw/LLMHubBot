/**
 * @module index
 * @description Main entry point for the LLMHub Discord bot. Sets up the Discord client,
 * registers slash commands, initializes the tool registry, agent loop, and thinking
 * orchestrator, and wires up all event handlers.
 */

const config = require('./config');
const logger = require('./logger');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getState, setState, insertFeedback } = require('./db');
const { handleMessage, setAgentLoop, setOrchestrator, modelQueue, debouncer } = require('./handlers/messageHandler');
const { handleInteraction } = require('./handlers/interactionHandler');
const ToolRegistry = require('./tools/registry');
const AgentLoop = require('./agent-loop');
const ThinkingOrchestrator = require('./thinking/orchestrator');
const openaiClient = require('./openai-client');

// ── Boot timestamp for uptime tracking ──
const bootTime = Date.now();

// ── Global error handlers ──
process.on('unhandledRejection', (reason) => {
  logger.error('Process', 'Unhandled rejection:', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (err) => {
  logger.error('Process', 'Uncaught exception:', err);
  process.exit(1);
});

// ── Client setup ──
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: ['MESSAGE', 'REACTION'],
});

// ── Slash commands ──
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    const chatCmd = new SlashCommandBuilder()
      .setName('chat')
      .setDescription('Start a conversation thread with LLMHub');
    const imagineCmd = new SlashCommandBuilder()
      .setName('imagine')
      .setDescription('Generate an image from a text prompt')
      .addStringOption(opt => opt.setName('prompt').setDescription('What to generate').setRequired(true))
      .addStringOption(opt => opt.setName('size').setDescription('Image size').addChoices(
        { name: '1024×1024 (Square)', value: '1024x1024' },
        { name: '1536×1024 (Landscape)', value: '1536x1024' },
        { name: '1024×1536 (Portrait)', value: '1024x1536' },
      ));
    const toolsCmd = new SlashCommandBuilder()
      .setName('tools')
      .setDescription('List all available tools LLMHub can use');
    const resetCmd = new SlashCommandBuilder()
      .setName('reset')
      .setDescription('Clear conversation context for this channel');
    const helpCmd = new SlashCommandBuilder()
      .setName('help')
      .setDescription('See everything LLMHub can do');
    const exportCmd = new SlashCommandBuilder()
      .setName('export')
      .setDescription('Export the current conversation as a markdown file');
    const statsCmd = new SlashCommandBuilder()
      .setName('stats')
      .setDescription('View bot statistics (admin only)');
    const settingsCmd = new SlashCommandBuilder()
      .setName('settings')
      .setDescription('Configure your LLMHub preferences')
      .addStringOption(opt => opt.setName('verbosity').setDescription('Response length preference')
        .addChoices(
          { name: 'Concise', value: 'concise' },
          { name: 'Normal', value: 'normal' },
          { name: 'Detailed', value: 'detailed' },
        ))
      .addBooleanOption(opt => opt.setName('images').setDescription('Enable/disable image generation in responses'));
    await rest.put(
      Routes.applicationGuildCommands(config.appId, config.guildId),
      { body: [chatCmd.toJSON(), imagineCmd.toJSON(), toolsCmd.toJSON(), resetCmd.toJSON(), settingsCmd.toJSON(), helpCmd.toJSON(), exportCmd.toJSON(), statsCmd.toJSON()] }
    );
    logger.info('Bot', 'Slash commands registered');
  } catch (err) {
    logger.error('Bot', 'Command registration failed:', err);
  }
}

// ── Startup embed ──
async function sendStartupEmbed() {
  try {
    const lastStartup = getState('last_startup_embed');
    const now = Date.now();
    if (lastStartup && now - parseInt(lastStartup, 10) < 3600000) return; // <1 hour

    const channel = client.channels.cache.get(config.gptChannelId);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('🟢 LLMHub is Online')
      .setDescription('Ready to chat! Tag me or use `/chat` to start a conversation.')
      .addFields({
        name: 'Features',
        value: '• Smart group chat\n• Threaded conversations\n• Long-term memory\n• Content moderation',
        inline: false,
      })
      .setFooter({ text: 'Uptime: Just started • Memory: Active' })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    setState('last_startup_embed', String(now));
  } catch (err) {
    logger.error('Bot', 'Startup embed error:', err);
  }
}

// ── Initialize Tool Registry, Agent Loop & Thinking Orchestrator ──
const registry = new ToolRegistry();
registry.loadAll();
ToolRegistry.setInstance(registry);

if (config.enableAgentLoop) {
  const agentLoop = new AgentLoop(registry, openaiClient, config);
  setAgentLoop(agentLoop);

  if (config.thinkingLayersEnabled) {
    const orchestrator = new ThinkingOrchestrator({
      toolRegistry: registry,
      agentLoop,
      config,
    });
    orchestrator.setModelQueue(modelQueue);
    setOrchestrator(orchestrator);
    logger.info('Bot', `5-layer thinking system enabled with ${registry.listTools().length} tools`);
  } else {
    logger.info('Bot', `Agent loop enabled with ${registry.listTools().length} tools`);
  }
}

// ── Health endpoint ──
const { startHealthServer } = require('./health');
const { getStats } = require('./handlers/messageHandler');
startHealthServer(3870, () => {
  const stats = getStats();
  return {
    queues: stats.queueStats,
    messagesProcessed: stats.messageCount,
    errors: stats.errorCount,
    debouncer: debouncer.getStats(),
  };
});

// ── Register handlers ──
client.on('messageCreate', handleMessage);
client.on('interactionCreate', handleInteraction);

// ── Message edit/delete handling ──
const { updateMessage, deleteMessage } = require('./context');

client.on('messageUpdate', async (oldMessage, newMessage) => {
  try {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (config.allowedGuildId && newMessage.guild.id !== config.allowedGuildId) return;
    const allowedChannels = config.allowedChannelIds;
    const chId = newMessage.channel?.id;
    const parentId = newMessage.channel?.parentId;
    if (allowedChannels.length > 0 && !allowedChannels.includes(chId) && !allowedChannels.includes(parentId)) return;

    const content = newMessage.content || '';
    if (content.length === 0) return;

    await updateMessage(chId, newMessage.id, content);
    logger.info('MessageEdit', `${newMessage.author?.username} edited message ${newMessage.id} in ${chId}`);
  } catch (err) {
    logger.error('MessageEdit', 'Error handling edit:', err);
  }
});

client.on('messageDelete', async (message) => {
  try {
    if (!message.guild) return;
    if (config.allowedGuildId && message.guild.id !== config.allowedGuildId) return;
    const chId = message.channel?.id;
    const parentId = message.channel?.parentId;
    const allowedChannels = config.allowedChannelIds;
    if (allowedChannels.length > 0 && !allowedChannels.includes(chId) && !allowedChannels.includes(parentId)) return;

    await deleteMessage(chId, message.id);
    logger.info('MessageDelete', `Message ${message.id} deleted from ${chId}`);
  } catch (err) {
    logger.error('MessageDelete', 'Error handling delete:', err);
  }
});

// ── Reaction feedback (👍/👎) ──
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    // Fetch partial if needed
    if (reaction.partial) {
      try { await reaction.fetch(); } catch (_) { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch (_) { return; }
    }
    // Only track reactions on bot's own messages
    if (reaction.message.author?.id !== client.user.id) return;

    const emoji = reaction.emoji.name;
    if (emoji === '👍' || emoji === '👎') {
      insertFeedback(reaction.message.id, user.id, reaction.message.channel.id, emoji, Date.now());

      if (emoji === '👎') {
        logger.info('Feedback', `Negative feedback from ${user.tag} on message ${reaction.message.id}`);
      }
    }
  } catch (err) {
    logger.error('Feedback', 'Error handling reaction:', err);
  }
});

// ── Graceful shutdown ──
let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const uptime = Math.round((Date.now() - bootTime) / 1000);
  const { getStats } = require('./handlers/messageHandler');
  const stats = getStats();
  const { getToolStats } = require('./db');
  let toolStats = [];
  try { toolStats = getToolStats(); } catch (_) {}

  logger.info('Bot', `Received ${signal}, shutting down gracefully... Uptime: ${uptime}s`);
  logger.info('Bot', `Shutdown stats: ${stats.messageCount} messages processed, ${stats.errorCount} errors, ${toolStats.length} tool types used`);

  // Give in-progress responses up to 5s to finish
  await new Promise(r => setTimeout(r, 5000));

  try { client.destroy(); } catch (_) {}
  try { const { close: dbClose } = require('./db'); dbClose(); } catch (_) {}
  logger.info('Bot', 'Shutdown complete.');

  // Grace period before hard exit
  setTimeout(() => process.exit(0), 10000);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start ──
client.once('ready', () => {
  logger.info('Bot', `Logged in as ${client.user.tag}`);
  logger.info('Bot', 'Production hardened: concurrency limiting, queue, WAL mode, embeds');
  sendStartupEmbed();
});

registerCommands();
client.login(config.discordToken);
