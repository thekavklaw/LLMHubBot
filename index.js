require('dotenv').config();

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { getSystemPrompt, getSoulConfig, reflectAndUpdate } = require('./soul');
const { generateResponse } = require('./openai-client');
const { addMessage, getContext, getRecentContextMessages } = require('./context');
const { logMessage, getState, setState } = require('./db');
const { createChatThread } = require('./threads');
const { shouldRespond } = require('./relevance');
const { storeMemory, extractFacts } = require('./memory');
const { trackUser, updateProfilesFromFacts } = require('./users');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const GPT_CHANNEL_ID = process.env.GPT_CHANNEL_ID;

// ── Message counters ──
// Per-channel counter for fact extraction (every 15)
const channelMsgCounts = new Map();
// Global counter for reflection (every 50)
let globalMsgCount = parseInt(getState('global_msg_count') || '0', 10);

// Track userName -> userId mapping for fact attribution
const userNameToId = new Map();

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

function isGptThread(channel) {
  return channel.isThread() && channel.parentId === GPT_CHANNEL_ID;
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

// ── Fact extraction & memory pipeline ──
async function runFactExtraction(channelId) {
  try {
    const recentMsgs = getRecentContextMessages(channelId);
    if (recentMsgs.length < 5) return;

    console.log(`[Memory] Extracting facts from ${recentMsgs.length} messages in ${channelId}...`);
    const facts = await extractFacts(recentMsgs, channelId);
    if (facts.length === 0) return;

    console.log(`[Memory] Extracted ${facts.length} facts`);

    // Store each fact as a memory
    for (const fact of facts) {
      const userId = fact.userName ? userNameToId.get(fact.userName) : null;
      await storeMemory(fact.content, {
        userId,
        userName: fact.userName,
        channelId,
        category: fact.category,
      });
    }

    // Update user profiles from facts
    updateProfilesFromFacts(facts, userNameToId);
  } catch (err) {
    console.error('[Memory] Fact extraction pipeline error:', err.message);
  }
}

// ── Handle messages ──
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!isGptChannel(message.channel)) return;

  const channelId = message.channel.id;
  const userId = message.author.id;
  const userName = message.author.username;
  const displayName = message.member?.displayName || userName;

  // Track user profile
  trackUser(userId, userName, displayName);
  userNameToId.set(userName, userId);

  // Log & add to context (always, even if we don't respond)
  addMessage(channelId, 'user', message.content, userName);
  logMessage(channelId, userId, userName, 'user', message.content);

  // Skip trivial messages before any processing
  if (message.content.trim().length < 1) return;

  // ── Message counters for memory pipeline ──
  const chCount = (channelMsgCounts.get(channelId) || 0) + 1;
  channelMsgCounts.set(channelId, chCount);
  globalMsgCount++;
  setState('global_msg_count', String(globalMsgCount));

  // Every 15 messages per channel: extract facts
  if (chCount % 15 === 0) {
    runFactExtraction(channelId).catch(err =>
      console.error('[Memory] Background extraction error:', err.message)
    );
  }

  // Every 50 messages globally: reflect and update soul
  if (globalMsgCount % 50 === 0) {
    reflectAndUpdate().catch(err =>
      console.error('[Soul] Background reflection error:', err.message)
    );
  }

  // Threads under #gpt: ALWAYS respond
  const alwaysRespond = isGptThread(message.channel);

  if (!alwaysRespond && message.channel.id === GPT_CHANNEL_ID) {
    // Smart relevance check for main #gpt channel
    const recentMessages = getRecentContextMessages(channelId);
    const decision = await shouldRespond(message, recentMessages, client.user.id);
    console.log(`[Relevance] ${userName}: "${message.content.slice(0, 60)}" → respond=${decision.respond} (${decision.confidence}) — ${decision.reason}`);

    if (!decision.respond) return;
  }

  // Build system prompt with soul + memories + user profile
  const config = getSoulConfig();
  const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
  const messages = [
    { role: 'system', content: systemPrompt },
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
  console.log(`[Bot] Phase 3 active: Memory, Users, Soul`);
  console.log(`[Bot] Global message count: ${globalMsgCount}`);
});

registerCommands().catch(err => console.error('[Bot] Command registration failed:', err.message));
client.login(process.env.DISCORD_TOKEN);
