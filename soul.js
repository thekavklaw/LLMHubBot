const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { searchMemory } = require('./memory');
const { formatProfileForPrompt } = require('./users');
const { getRecentMessages } = require('./db');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SOUL_PATH = path.join(__dirname, 'data', 'soul.md');

/**
 * Read soul.md content.
 */
function getSoulContent() {
  try {
    return fs.readFileSync(SOUL_PATH, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Build the full system prompt with soul, memories, and user profile.
 * @param {string} channelId
 * @param {string} userId
 * @param {string} currentMessage - The user's current message (for memory search)
 * @returns {Promise<string>}
 */
async function getSystemPrompt(channelId, userId, currentMessage) {
  const parts = [];

  // Soul identity
  const soul = getSoulContent();
  if (soul) {
    parts.push(soul);
  }

  // Channel context instruction
  parts.push(`\nYou're in a Discord group conversation. Keep responses concise (under 2000 chars). Use markdown sparingly. Match the energy of the conversation. Don't respond to everything — only when you can genuinely add value.`);

  // Relevant memories from RAG search
  if (currentMessage) {
    try {
      const memories = await searchMemory(currentMessage, 3, 0.65);
      if (memories.length > 0) {
        const memText = memories.map(m =>
          `- ${m.content}${m.userName ? ` (about ${m.userName})` : ''}`
        ).join('\n');
        parts.push(`\n## Relevant Things I Remember\n${memText}`);
      }
    } catch (err) {
      console.error('[Soul] Memory search error:', err.message);
    }
  }

  // User profile
  if (userId) {
    const profileInfo = formatProfileForPrompt(userId);
    if (profileInfo) {
      parts.push(`\n## About the Current User\n${profileInfo}`);
    }
  }

  return parts.join('\n');
}

function getSoulConfig() {
  return {
    name: 'LLMHub',
    temperature: 0.8,
    model: 'gpt-4o',
    maxTokens: 1000,
  };
}

/**
 * Reflect on recent conversations and update soul.md "What I've Learned" section.
 */
async function reflectAndUpdate() {
  try {
    const channelId = process.env.GPT_CHANNEL_ID;
    const recentMsgs = getRecentMessages(channelId, 50);
    if (recentMsgs.length < 10) return;

    const transcript = recentMsgs
      .map(m => `${m.user_name || m.role}: ${m.content}`)
      .join('\n');

    const currentSoul = getSoulContent();
    const learnedMatch = currentSoul.match(/## What I've Learned\n([\s\S]*)/);
    const currentLearned = learnedMatch ? learnedMatch[1].trim() : '';

    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: `You are LLMHub reflecting on recent conversations. Based on the transcript, write a brief updated "What I've Learned" section for your identity file. Include insights about the community, recurring topics, and things you've discovered. Keep it concise — bullet points. Build on what you already know.

Current "What I've Learned":
${currentLearned || '(nothing yet)'}

Write ONLY the content that goes under "## What I've Learned" — no heading, just the bullet points.`
        },
        { role: 'user', content: transcript }
      ],
    });

    const newLearned = res.choices[0]?.message?.content?.trim();
    if (!newLearned) return;

    // Update soul.md
    const updatedSoul = currentSoul.replace(
      /## What I've Learned\n[\s\S]*/,
      `## What I've Learned\n${newLearned}\n`
    );
    fs.writeFileSync(SOUL_PATH, updatedSoul, 'utf-8');
    console.log(`[Soul] Reflection updated: ${newLearned.slice(0, 80)}...`);
  } catch (err) {
    console.error('[Soul] Reflection error:', err.message);
  }
}

module.exports = { getSystemPrompt, getSoulConfig, reflectAndUpdate };
