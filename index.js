require('dotenv').config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const { getSystemPrompt, getSoulConfig } = require('./soul');
const { generateResponse } = require('./openai-client');
const { addMessage, getContext } = require('./context');
const { logMessage } = require('./db');
const { createChatThread } = require('./threads');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const GPT_CHANNEL_ID = process.env.GPT_CHANNEL_ID;

// ── Slash command registration ──
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const chatCmd = new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Start a conversation thread with LLMHub');

  await rest.put(
    Routes.applicationGuildCommands(process.env.APP_ID, process.env.GUILD_ID),
    { body: [chatCmd.toJSON()] }
  );
  console.log('[Bot] Slash commands registered');
}

// ── Check if channel is #gpt or a thread under #gpt ──
function isGptChannel(channel) {
  if (channel.id === GPT_CHANNEL_ID) return true;
  if (channel.isThread() && channel.parentId === GPT_CHANNEL_ID) return true;
  return false;
}

// ── Split long messages ──
function splitMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  while (text.length > 0) {
    let splitAt = maxLen;
    if (text.length > maxLen) {
      const lastNewline = text.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.5) splitAt = lastNewline;
    }
    parts.push(text.slice(0, splitAt));
    text = text.slice(splitAt);
  }
  return parts;
}

// ── Handle messages ──
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!isGptChannel(message.channel)) return;
  if (message.content.trim().length < 3) return;

  const channelId = message.channel.id;
  const userName = message.author.username;

  // Log & add to context
  addMessage(channelId, 'user', message.content, userName);
  logMessage(channelId, message.author.id, userName, 'user', message.content);

  // Build messages for OpenAI
  const config = getSoulConfig();
  const messages = [
    { role: 'system', content: getSystemPrompt() },
    ...getContext(channelId),
  ];

  try {
    await message.channel.sendTyping();
    const response = await generateResponse(messages, config);

    // Log assistant response
    addMessage(channelId, 'assistant', response);
    logMessage(channelId, null, 'LLMHub', 'assistant', response);

    // Send (split if needed)
    for (const part of splitMessage(response)) {
      await message.channel.send(part);
    }
  } catch (err) {
    console.error('[Bot] Error generating response:', err.message);
    await message.channel.send("Sorry, I encountered an error. Try again in a moment.").catch(() => {});
  }
});

// ── Handle interactions ──
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'chat') return;

  try {
    await interaction.deferReply({ ephemeral: true });
    const thread = await createChatThread(interaction);
    await interaction.editReply({ content: `Thread created! Head over to ${thread}` });
  } catch (err) {
    console.error('[Bot] Error creating thread:', err.message);
    const reply = interaction.deferred
      ? interaction.editReply({ content: 'Sorry, I couldn\'t create a thread.' })
      : interaction.reply({ content: 'Sorry, I couldn\'t create a thread.', ephemeral: true });
    await reply.catch(() => {});
  }
});

// ── Start ──
client.once('ready', () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
});

registerCommands().catch(err => console.error('[Bot] Command registration failed:', err.message));
client.login(process.env.DISCORD_TOKEN);
