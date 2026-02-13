/**
 * @module handlers/interactionHandler
 * @description Handles Discord slash command interactions (/chat, /imagine, /tools, /reset, /settings).
 */

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createChatThread } = require('../threads');
const { generateImage, thinkWithModel } = require('../openai-client');
const { clearChannelContext } = require('../context');
const { getUserSettings, saveUserSettings } = require('../db');
const { friendlyError } = require('../utils/errors');
const config = require('../config');
const logger = require('../logger');

// Rate limit: max 3 /imagine per user per 10 minutes
const imagineRateLimits = new Map();
const IMAGINE_LIMIT = 3;
const IMAGINE_WINDOW = 10 * 60 * 1000;

function checkImagineRateLimit(userId) {
  const now = Date.now();
  const entry = imagineRateLimits.get(userId) || [];
  const recent = entry.filter(t => now - t < IMAGINE_WINDOW);
  imagineRateLimits.set(userId, recent);
  if (recent.length >= IMAGINE_LIMIT) {
    const oldest = recent[0];
    const retryAfter = Math.ceil((IMAGINE_WINDOW - (now - oldest)) / 1000);
    return { allowed: false, retryAfter };
  }
  recent.push(now);
  return { allowed: true };
}

const TOOL_ICONS = {
  brave_search: '🔍', tavily_search: '🌐', generate_image: '🎨',
  calculator: '🧮', timestamp: '🕐', define_word: '📖',
  summarize_url: '📄', remember: '💾', recall: '🔎', code_runner: '💻',
};

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  // Block DMs
  if (!interaction.guild) {
    return interaction.reply({ content: '❌ Commands are not available in DMs.', ephemeral: true });
  }

  // Block other guilds
  if (config.allowedGuildId && interaction.guild.id !== config.allowedGuildId) {
    return interaction.reply({ content: '❌ This bot is not available in this server.', ephemeral: true });
  }

  // Channel whitelist
  const allowedChannels = config.allowedChannelIds;
  if (allowedChannels.length > 0) {
    const channelId = interaction.channel?.id;
    const parentId = interaction.channel?.parentId;
    if (!allowedChannels.includes(channelId) && !allowedChannels.includes(parentId)) {
      return interaction.reply({ content: '❌ Commands are not available in this channel.', ephemeral: true });
    }
  }

  if (interaction.commandName === 'tools') {
    try {
      const ToolRegistry = require('../tools/registry');
      // Get the registry instance from the module cache or create temp one
      const registry = new ToolRegistry();
      registry.loadAll();
      const tools = registry.listTools();
      const lines = tools.map(t => `${TOOL_ICONS[t.name] || '🔧'} **${t.name}** — ${t.description.split('.')[0]}`);
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🧰 Available Tools')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${tools.length} tools loaded` })
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      logger.error('Interaction', '/tools error:', err);
      return interaction.reply({ content: '❌ Failed to list tools.', ephemeral: true });
    }
  }

  if (interaction.commandName === 'reset') {
    try {
      const channelId = interaction.channel?.id;
      await clearChannelContext(channelId);
      return interaction.reply({ content: '🔄 Conversation context cleared! I\'ll start fresh.', ephemeral: true });
    } catch (err) {
      logger.error('Interaction', '/reset error:', err);
      return interaction.reply({ content: friendlyError(err), ephemeral: true });
    }
  }

  if (interaction.commandName === 'settings') {
    try {
      const userId = interaction.user.id;
      const verbosity = interaction.options.getString('verbosity');
      const images = interaction.options.getBoolean('images');

      // Load current settings
      let current = getUserSettings(userId) || { verbosity: 'normal', images_enabled: 1 };

      // Update if options provided
      const newVerbosity = verbosity || current.verbosity || 'normal';
      const newImages = images !== null && images !== undefined ? images : !!current.images_enabled;

      saveUserSettings(userId, newVerbosity, newImages);

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('⚙️ Your Settings')
        .addFields(
          { name: '📝 Verbosity', value: newVerbosity, inline: true },
          { name: '🎨 Images', value: newImages ? 'Enabled' : 'Disabled', inline: true },
        )
        .setFooter({ text: 'Use /settings to change these anytime' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (err) {
      logger.error('Interaction', '/settings error:', err);
      return interaction.reply({ content: friendlyError(err), ephemeral: true });
    }
  }

  if (interaction.commandName === 'chat') {
    try {
      await interaction.deferReply({ ephemeral: true });
      const thread = await createChatThread(interaction);
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setDescription(`✅ Thread created! Head over to ${thread}`);
      await interaction.editReply({ embeds: [embed] });

      // Smart thread title: after first response, rename with a topic summary
      smartRenameThread(thread).catch(err => logger.error('Interaction', 'Smart rename error:', err));
    } catch (err) {
      logger.error('Interaction', 'Error:', err);
      try {
        const reply = interaction.deferred
          ? interaction.editReply({ content: friendlyError(err) })
          : interaction.reply({ content: friendlyError(err), ephemeral: true });
        await reply;
      } catch (_) {}
    }
    return;
  }

  if (interaction.commandName === 'imagine') {
    const prompt = interaction.options.getString('prompt');
    const size = interaction.options.getString('size') || '1024x1024';

    // Rate limit check
    const rateCheck = checkImagineRateLimit(interaction.user.id);
    if (!rateCheck.allowed) {
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(0xFEE75C).setDescription(`⏳ You can use /imagine ${IMAGINE_LIMIT} times per 10 minutes. Try again in ${rateCheck.retryAfter}s.`)],
        ephemeral: true,
      });
    }

    try {
      await interaction.deferReply();
      logger.info('Imagine', `${interaction.user.username}: "${prompt}" (${size})`);

      const imageBuffer = await generateImage(prompt, size);
      const attachment = new AttachmentBuilder(imageBuffer, { name: 'imagine.png' });

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎨 /imagine')
        .setDescription(`**Prompt:** ${prompt}`)
        .setImage('attachment://imagine.png')
        .setFooter({ text: `Size: ${size} • Requested by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (err) {
      logger.error('Imagine', 'Error:', err);
      try {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xED4245).setDescription(`❌ Image generation failed: ${err.message}`)] });
      } catch (_) {}
    }
    return;
  }
}

/**
 * Wait for the first user message in a thread, then rename with a smart title.
 * @param {Object} thread - Discord thread channel
 */
async function smartRenameThread(thread) {
  // Wait up to 60s for first user message
  try {
    const collected = await thread.awaitMessages({
      filter: m => !m.author.bot,
      max: 1,
      time: 60000,
    });
    const firstMsg = collected.first();
    if (!firstMsg || !firstMsg.content) return;

    const result = await thinkWithModel([
      { role: 'system', content: 'Summarize this message topic in 3-5 words for a thread title. Return JSON: {"title":"..."}' },
      { role: 'user', content: firstMsg.content.slice(0, 300) },
    ], 'gpt-4.1-mini');

    const parsed = JSON.parse(result);
    const title = parsed.title || 'Chat';
    await thread.setName(title.slice(0, 100));
    logger.info('Interaction', `Smart-renamed thread ${thread.id} to "${title}"`);
  } catch (err) {
    logger.warn('Interaction', `Smart rename fallback for thread ${thread.id}:`, err.message);
    // Don't change name on failure — keep the default
  }
}

/**
 * Generate a smart thread title from content.
 * Exported for testing.
 * @param {string} content - Message content to summarize
 * @returns {Promise<string>} A 3-5 word title
 */
async function generateSmartTitle(content) {
  const result = await thinkWithModel([
    { role: 'system', content: 'Summarize this message topic in 3-5 words for a thread title. Return JSON: {"title":"..."}' },
    { role: 'user', content: content.slice(0, 300) },
  ], 'gpt-4.1-mini');
  const parsed = JSON.parse(result);
  return parsed.title || 'Chat';
}

module.exports = { handleInteraction, generateSmartTitle };
