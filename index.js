const config = require('./config');
const logger = require('./logger');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getState, setState } = require('./db');
const { handleMessage, setAgentLoop, setOrchestrator } = require('./handlers/messageHandler');
const { handleInteraction } = require('./handlers/interactionHandler');
const ToolRegistry = require('./tools/registry');
const AgentLoop = require('./agent-loop');
const ThinkingOrchestrator = require('./thinking/orchestrator');
const openaiClient = require('./openai-client');

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
  ],
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
    await rest.put(
      Routes.applicationGuildCommands(config.appId, config.guildId),
      { body: [chatCmd.toJSON(), imagineCmd.toJSON()] }
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

if (config.enableAgentLoop) {
  const agentLoop = new AgentLoop(registry, openaiClient, config);
  setAgentLoop(agentLoop);

  if (config.thinkingLayersEnabled) {
    const orchestrator = new ThinkingOrchestrator({
      toolRegistry: registry,
      agentLoop,
      config,
    });
    setOrchestrator(orchestrator);
    logger.info('Bot', `5-layer thinking system enabled with ${registry.listTools().length} tools`);
  } else {
    logger.info('Bot', `Agent loop enabled with ${registry.listTools().length} tools`);
  }
}

// ── Register handlers ──
client.on('messageCreate', handleMessage);
client.on('interactionCreate', handleInteraction);

// ── Graceful shutdown ──
function shutdown(signal) {
  logger.info('Bot', `Received ${signal}, shutting down...`);
  client.destroy();
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
