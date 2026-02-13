const { ChannelType, EmbedBuilder } = require('discord.js');
const config = require('./config');

async function createChatThread(interaction) {
  const gptChannel = interaction.client.channels.cache.get(config.gptChannelId);
  if (!gptChannel) throw new Error('GPT channel not found');

  const now = new Date();
  const shortDate = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase().replace(/\s/g, '');
  const threadName = `${interaction.user.username}-chat-${shortDate}`;

  const thread = await gptChannel.threads.create({
    name: threadName,
    type: ChannelType.PublicThread,
    reason: `Chat thread created by ${interaction.user.username}`,
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('💬 New Conversation')
    .setDescription(`Hey ${interaction.member?.displayName || interaction.user.username}! I'm **LLMHub** — your AI assistant.\n\nAsk me anything about AI, LLMs, machine learning, or tech. Others can join this thread too!`)
    .addFields(
      { name: '🧠 Model', value: 'GPT-4o', inline: true },
      { name: '💾 Memory', value: 'Enabled', inline: true },
      { name: '🛡️ Moderation', value: 'Active', inline: true }
    )
    .setFooter({ text: 'LLMHub • Powered by OpenAI' })
    .setTimestamp();

  await thread.send({ embeds: [embed] });
  return thread;
}

module.exports = { createChatThread };
