const { ChannelType } = require('discord.js');

/**
 * Create a public thread in #gpt for a /chat interaction.
 */
async function createChatThread(interaction) {
  const gptChannel = interaction.client.channels.cache.get(process.env.GPT_CHANNEL_ID);
  if (!gptChannel) throw new Error('GPT channel not found');

  const now = new Date();
  const shortDate = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase().replace(/\s/g, '');
  const threadName = `${interaction.user.username}-chat-${shortDate}`;

  const thread = await gptChannel.threads.create({
    name: threadName,
    type: ChannelType.PublicThread,
    reason: `Chat thread created by ${interaction.user.username}`,
  });

  await thread.send("Hey! I'm LLMHub — ask me anything. Others can join this thread too.");

  return thread;
}

module.exports = { createChatThread };
