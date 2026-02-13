const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createChatThread } = require('../threads');
const { generateImage } = require('../openai-client');
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

  if (interaction.commandName === 'chat') {
    try {
      await interaction.deferReply({ ephemeral: true });
      const thread = await createChatThread(interaction);
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setDescription(`✅ Thread created! Head over to ${thread}`);
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error('Interaction', 'Error:', err);
      try {
        const reply = interaction.deferred
          ? interaction.editReply({ content: "Sorry, I couldn't create a thread." })
          : interaction.reply({ content: "Sorry, I couldn't create a thread.", ephemeral: true });
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

module.exports = { handleInteraction };
