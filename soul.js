const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { searchMemory } = require('./memory');
const { formatProfileForPrompt } = require('./users');
const { getRecentMessages } = require('./db');
const config = require('./config');
const logger = require('./logger');

const openai = new OpenAI({ apiKey: config.openaiApiKey });
const SOUL_PATH = path.join(__dirname, 'data', 'soul.md');
const CHANGELOG_PATH = path.join(__dirname, 'data', 'changelog.md');

// Cache changelog on load — only re-read on restart (which is exactly when it changes)
let _changelogCache = null;
function getChangelog() {
  if (_changelogCache !== null) return _changelogCache;
  try {
    const raw = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
    // Only keep the most recent entry to save tokens
    const entries = raw.split(/^## \d{4}-/m);
    const header = entries[0]; // "# Brain Changelog\n..."
    const latest = entries[1] ? '## ' + entries[1].split(/^## \d{4}-/m)[0].trim() : '';
    _changelogCache = latest ? `\n## What Changed in My Last Update\n${latest}` : '';
    logger.info('Soul', `Changelog loaded (${_changelogCache.length} chars, latest entry only)`);
  } catch {
    _changelogCache = '';
  }
  return _changelogCache;
}

function getSoulContent() {
  try { return fs.readFileSync(SOUL_PATH, 'utf-8'); } catch { return ''; }
}

async function getSystemPrompt(channelId, userId, currentMessage, preloadedMemories) {
  const parts = [];
  const soul = getSoulContent();
  if (soul) parts.push(soul);

  const changelog = getChangelog();
  if (changelog) parts.push(changelog);

  parts.push(`\nYou're in a Discord group conversation. Keep responses concise (under 2000 chars). Use markdown sparingly. Match the energy of the conversation. Don't respond to everything — only when you can genuinely add value.`);

  if (config.features.memory) {
    try {
      // Use preloaded memories if available, otherwise search
      const memories = preloadedMemories || (currentMessage ? await searchMemory(currentMessage, 5, 0.65) : []);
      if (memories.length > 0) {
        const memText = memories.map(m =>
          `- ${m.content}${m.userName ? ` (about ${m.userName})` : ''}`
        ).join('\n');
        parts.push(`\n## Relevant Things I Remember\n${memText}`);
        parts.push(`\nIf you have memory context about this user, reference it naturally when relevant. Use phrases like "If I remember right, you mentioned...", "You told me before that...", "I recall you...", or "Based on what you've shared...". Don't force it — only when it genuinely connects to what they're saying.`);
      }
    } catch (err) {
      logger.error('Soul', 'Memory search error:', err);
    }
  }

  if (userId) {
    const profileInfo = formatProfileForPrompt(userId);
    if (profileInfo) parts.push(`\n## About the Current User\n${profileInfo}`);
  }

  return parts.join('\n');
}

/** Emotional tone guidance map (used by layer3-execute). */
const EMOTION_GUIDANCE = {
  frustrated: "The user seems frustrated. Be extra patient, acknowledge the difficulty, and be precise.",
  confused: "The user seems confused. Start from basics, use analogies, go step by step.",
  excited: "The user is excited! Match their energy while being accurate.",
  appreciative: "The user appreciated something. Acknowledge it naturally, don't be overly modest.",
  curious: "The user is curious. Encourage exploration, suggest related topics.",
};

function getEmotionGuidance(emotion) {
  if (!emotion || emotion === 'neutral') return null;
  return EMOTION_GUIDANCE[emotion] || null;
}

function getSoulConfig() {
  return {
    name: 'LLMHub',
    temperature: config.temperature,
    model: config.model,
    maxTokens: config.maxTokens,
  };
}

async function reflectAndUpdate(threadChannelId) {
  try {
    // Reflect on the provided channel (thread or main), falling back to gptChannelId
    const channelId = threadChannelId || config.gptChannelId;
    const recentMsgs = getRecentMessages(channelId, 50);
    if (recentMsgs.length < 10) return;

    const transcript = recentMsgs.map(m => `${m.user_name || m.role}: ${m.content}`).join('\n');
    const currentSoul = getSoulContent();
    const learnedMatch = currentSoul.match(/## What I've Learned\n([\s\S]*)/);
    const currentLearned = learnedMatch ? learnedMatch[1].trim() : '';

    const res = await openai.chat.completions.create({
      model: config.miniModel,
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

    const updatedSoul = currentSoul.replace(
      /## What I've Learned\n[\s\S]*/,
      `## What I've Learned\n${newLearned}\n`
    );
    // Atomic write: write to temp file, then rename to prevent corruption
    const tmpPath = SOUL_PATH + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, updatedSoul, 'utf-8');
    fs.renameSync(tmpPath, SOUL_PATH);
    logger.info('Soul', `Reflection updated: ${newLearned.slice(0, 80)}...`);
  } catch (err) {
    logger.error('Soul', 'Reflection error:', err);
  }
}

module.exports = { getSystemPrompt, getSoulConfig, reflectAndUpdate, getEmotionGuidance };
