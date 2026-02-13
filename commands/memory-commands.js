/**
 * @module commands/memory-commands
 * @description Slash command handlers for /remember, /forget, /memories.
 * Gives users direct control over what the bot remembers about them.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getUserMemoriesActive, softDeleteMemory, searchUserMemoriesByTopic } = require('../db');
const { storeMemory } = require('../memory');
const { appendUserMemory } = require('../memory-files');
const logger = require('../logger');

/**
 * Handle /remember — store a user-provided fact.
 */
async function handleRemember(interaction) {
  const fact = interaction.options.getString('fact');
  const userId = interaction.user.id;
  const userName = interaction.user.username;
  const displayName = interaction.member?.displayName || userName;
  const guildId = interaction.guild?.id || null;
  const channelId = interaction.channel?.id || null;

  try {
    await storeMemory(fact, {
      userId,
      userName,
      channelId,
      guildId,
      category: 'fact',
      significance: 1.0,
    });

    // Also write to markdown user file
    appendUserMemory(userId, displayName, `[curated] ${fact}`);

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setDescription(`🧠 Remembered: "${fact}"`)
      .setFooter({ text: 'Use /memories to see what I know about you' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
    logger.info('MemoryCmd', `${userName} stored: "${fact.slice(0, 60)}..."`);
  } catch (err) {
    logger.error('MemoryCmd', '/remember error:', err);
    await interaction.reply({ content: '❌ Failed to store that memory.', ephemeral: true });
  }
}

/**
 * Handle /forget — soft-delete memories matching a topic.
 */
async function handleForget(interaction) {
  const topic = interaction.options.getString('topic');
  const userId = interaction.user.id;
  const userName = interaction.user.username;

  try {
    const matches = searchUserMemoriesByTopic(userId, topic);

    if (matches.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setDescription(`I don't have any memories about "${topic}".`);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Show what will be forgotten with confirmation button
    const preview = matches.slice(0, 5).map(m => `• ${m.content.slice(0, 80)}`).join('\n');
    const more = matches.length > 5 ? `\n...and ${matches.length - 5} more` : '';

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle(`🗑️ Forget ${matches.length} memories about "${topic}"?`)
      .setDescription(`${preview}${more}`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`forget_confirm_${userId}_${topic}`).setLabel('Yes, forget them').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('forget_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    const reply = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true, fetchReply: true });

    // Button collector
    const collector = reply.createMessageComponentCollector({ time: 30000 });
    collector.on('collect', async (btn) => {
      if (btn.user.id !== userId) return;

      if (btn.customId.startsWith('forget_confirm_')) {
        for (const mem of matches) {
          softDeleteMemory(mem.id);
        }

        const doneEmbed = new EmbedBuilder()
          .setColor(0x57F287)
          .setDescription(`🗑️ Forgot ${matches.length} memories about "${topic}".`);
        await btn.update({ embeds: [doneEmbed], components: [] });
        logger.info('MemoryCmd', `${userName} forgot ${matches.length} memories about "${topic}"`);
      } else {
        await btn.update({ content: 'Cancelled.', embeds: [], components: [] });
      }
      collector.stop();
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'time') {
        try { await interaction.editReply({ content: 'Timed out.', embeds: [], components: [] }); } catch (_) {}
      }
    });
  } catch (err) {
    logger.error('MemoryCmd', '/forget error:', err);
    await interaction.reply({ content: '❌ Failed to search memories.', ephemeral: true });
  }
}

/**
 * Handle /memories — show paginated embed of what the bot knows about the user.
 */
async function handleMemories(interaction) {
  const userId = interaction.user.id;
  const displayName = interaction.member?.displayName || interaction.user.username;

  try {
    const allMemories = getUserMemoriesActive(userId);

    if (allMemories.length === 0) {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🧠 What I Remember About ${displayName}`)
        .setDescription("I don't have any memories about you yet. Chat with me and I'll start learning!");
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Group by tier
    const curated = allMemories.filter(m => m.tier === 'curated');
    const observations = allMemories.filter(m => m.tier !== 'curated');
    const ordered = [...curated, ...observations];

    const PER_PAGE = 10;
    const totalPages = Math.ceil(ordered.length / PER_PAGE);

    function buildPage(page) {
      const start = page * PER_PAGE;
      const items = ordered.slice(start, start + PER_PAGE);

      const lines = items.map(m => {
        const sigBar = m.significance >= 0.8 ? '🔴' : m.significance >= 0.5 ? '🟡' : '⚪';
        const tierTag = m.tier === 'curated' ? '📌' : '';
        return `${sigBar}${tierTag} ${m.content.slice(0, 100)}`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🧠 What I Remember About ${displayName}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Total: ${ordered.length} memories | Page ${page + 1}/${totalPages} | Use /forget [topic] to remove` });

      return embed;
    }

    let currentPage = 0;
    const embed = buildPage(0);

    if (totalPages <= 1) {
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Paginated
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mem_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('mem_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(totalPages <= 1),
    );

    const reply = await interaction.reply({ embeds: [embed], components: [row], ephemeral: true, fetchReply: true });

    const collector = reply.createMessageComponentCollector({ time: 120000 });
    collector.on('collect', async (btn) => {
      if (btn.user.id !== userId) return;

      if (btn.customId === 'mem_next') currentPage = Math.min(currentPage + 1, totalPages - 1);
      if (btn.customId === 'mem_prev') currentPage = Math.max(currentPage - 1, 0);

      const newRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mem_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
        new ButtonBuilder().setCustomId('mem_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= totalPages - 1),
      );

      await btn.update({ embeds: [buildPage(currentPage)], components: [newRow] });
    });

    collector.on('end', async () => {
      try { await interaction.editReply({ components: [] }); } catch (_) {}
    });
  } catch (err) {
    logger.error('MemoryCmd', '/memories error:', err);
    await interaction.reply({ content: '❌ Failed to retrieve memories.', ephemeral: true });
  }
}

module.exports = { handleRemember, handleForget, handleMemories };
