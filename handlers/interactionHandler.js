const { EmbedBuilder } = require('discord.js');
const { createChatThread } = require('../threads');
const logger = require('../logger');

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'chat') return;

  try {
    await interaction.deferReply({ ephemeral: true });
    const thread = await createChatThread(interaction);

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setDescription(`✅ Thread created! Head over to ${thread}`)

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    logger.error('Interaction', 'Error:', err);
    try {
      const reply = interaction.deferred
        ? interaction.editReply({ content: 'Sorry, I couldn\'t create a thread.' })
        : interaction.reply({ content: 'Sorry, I couldn\'t create a thread.', ephemeral: true });
      await reply;
    } catch (_) {}
  }
}

module.exports = { handleInteraction };
