require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { getSystemPrompt, getSoulConfig, reflectAndUpdate } = require('./soul');
const { generateResponse } = require('./openai-client');
const { addMessage, getContext, getRecentContextMessages } = require('./context');
const { logMessage, getState, setState } = require('./db');
const { createChatThread } = require('./threads');
const { shouldRespond } = require('./relevance');
const { storeMemory, extractFacts } = require('./memory');
const { trackUser, updateProfilesFromFacts } = require('./users');
const { checkMessage, checkOutput } = require('./moderator');
const { checkRateLimit } = require('./ratelimiter');

// ── Error logging ──
const ERROR_LOG = path.join(__dirname, 'data', 'error.log');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

function logError(label, err) {
  const line = `[${new Date().toISOString()}] [${label}] ${err.stack || err.message || err}\n`;
  console.error(line.trim());
  try { fs.appendFileSync(ERROR_LOG, line); } catch (_) {}
}

// ── Global error handlers ──
process.on('unhandledRejection', (reason) => {
  logError('UnhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', (err) => {
  logError('UncaughtException', err);
  process.exit(1);
});

// ── Health tracking ──
const startTime = Date.now();
let messageCount = 0;
let errorCount = 0;

function updateHealth() {
  try {
    setState('uptime_since', new Date(startTime).toISOString());
    setState('message_count', String(messageCount));
    setState('error_count', String(errorCount));
  } catch (_) {}
}

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
const channelMsgCounts = new Map();
let globalMsgCount = parseInt(getState('global_msg_count') || '0', 10);

const userNameToId = new Map();

// ── Slash command registration ──
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const chatCmd = new SlashCommandBuilder()
      .setName('chat')
      .setDescription('Start a conversation thread with LLMHub');

    await rest.put(
      Routes.applicationGuildCommands(process.env.APP_ID, process.env.GUILD_ID),
      { body: [chatCmd.toJSON()] }
    );
    console.log('[Bot] Slash commands registered');
  } catch (err) {
    logError('CommandRegistration', err);
  }
}

// ── Channel helpers ──
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

    for (const fact of facts) {
      const userId = fact.userName ? userNameToId.get(fact.userName) : null;
      await storeMemory(fact.content, {
        userId,
        userName: fact.userName,
        channelId,
        category: fact.category,
      });
    }

    updateProfilesFromFacts(facts, userNameToId);
  } catch (err) {
    logError('FactExtraction', err);
  }
}

// ── Handle messages ──
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!isGptChannel(message.channel)) return;

    const channelId = message.channel.id;
    const userId = message.author.id;
    const userName = message.author.username;
    const displayName = message.member?.displayName || userName;
    const inThread = isGptThread(message.channel);

    // Track user profile
    trackUser(userId, userName, displayName);
    userNameToId.set(userName, userId);

    // Log & add to context (always)
    addMessage(channelId, 'user', message.content, userName);
    logMessage(channelId, userId, userName, 'user', message.content);

    if (message.content.trim().length < 1) return;

    // ── Rate limit check ──
    const rateResult = checkRateLimit(userId, channelId, inThread);
    if (!rateResult.allowed) {
      console.log(`[RateLimit] Blocked ${userName} (retry in ${rateResult.retryAfter}s)`);
      return;
    }

    // ── Input moderation ──
    const modResult = await checkMessage(message);
    if (!modResult.safe) return;

    // ── Message counters ──
    messageCount++;
    const chCount = (channelMsgCounts.get(channelId) || 0) + 1;
    channelMsgCounts.set(channelId, chCount);
    globalMsgCount++;
    setState('global_msg_count', String(globalMsgCount));
    updateHealth();

    // Every 15 messages per channel: extract facts
    if (chCount % 15 === 0) {
      runFactExtraction(channelId).catch(err => logError('BackgroundExtraction', err));
    }

    // Every 50 messages globally: reflect and update soul
    if (globalMsgCount % 50 === 0) {
      reflectAndUpdate().catch(err => logError('BackgroundReflection', err));
    }

    // Threads: always respond. Main #gpt: smart relevance check.
    if (!inThread && message.channel.id === GPT_CHANNEL_ID) {
      try {
        const recentMessages = getRecentContextMessages(channelId);
        const decision = await shouldRespond(message, recentMessages, client.user.id);
        console.log(`[Relevance] ${userName}: "${message.content.slice(0, 60)}" → respond=${decision.respond} (${decision.confidence}) — ${decision.reason}`);
        if (!decision.respond) return;
      } catch (err) {
        logError('Relevance', err);
        // If relevance check fails, respond anyway
      }
    }

    // Build system prompt
    const config = getSoulConfig();
    const systemPrompt = await getSystemPrompt(channelId, userId, message.content);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...getContext(channelId),
    ];

    try {
      await message.channel.sendTyping();
    } catch (_) {}

    const response = await generateResponse(messages, config);

    // ── Output moderation ──
    const outMod = await checkOutput(response, channelId);
    if (!outMod.safe) {
      console.log('[Moderator] Blocked outgoing response');
      await message.channel.send("I generated a response but it was flagged by moderation. Let me try a different approach.").catch(() => {});
      return;
    }

    // Log assistant response
    addMessage(channelId, 'assistant', response);
    logMessage(channelId, null, 'LLMHub', 'assistant', response);

    for (const part of splitMessage(response)) {
      await message.channel.send(part);
    }
  } catch (err) {
    errorCount++;
    updateHealth();
    logError('MessageHandler', err);
    try {
      await message.channel.send("Sorry, I encountered an error. Try again in a moment.");
    } catch (_) {}
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
    errorCount++;
    updateHealth();
    logError('Interaction', err);
    try {
      const reply = interaction.deferred
        ? interaction.editReply({ content: 'Sorry, I couldn\'t create a thread.' })
        : interaction.reply({ content: 'Sorry, I couldn\'t create a thread.', ephemeral: true });
      await reply;
    } catch (_) {}
  }
});

// ── Graceful shutdown ──
function shutdown(signal) {
  console.log(`[Bot] Received ${signal}, shutting down gracefully...`);
  updateHealth();
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start ──
client.once('ready', () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  console.log(`[Bot] Phase 4 active: Moderation, Rate Limiting, Production Hardening`);
  console.log(`[Bot] Global message count: ${globalMsgCount}`);
  updateHealth();
});

try {
  registerCommands();
  client.login(process.env.DISCORD_TOKEN);
} catch (err) {
  logError('Startup', err);
  process.exit(1);
}
