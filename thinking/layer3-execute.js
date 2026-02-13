/**
 * @module thinking/layer3-execute
 * @description Execution layer that builds enhanced system prompts from intent
 * analysis and runs the agent loop with all available tools.
 */

const logger = require('../logger');
const { getSystemPrompt } = require('../soul');
const { getContext } = require('../context');
const { getUserSettings } = require('../db');

/**
 * Get dynamic model parameters based on intent type.
 */
function getModelParams(intent) {
  switch (intent) {
    case 'code_request': return { maxTokens: 2000, temperature: 0.3 };
    case 'image_request': return { maxTokens: 500, temperature: 0.7 };
    case 'creative': return { maxTokens: 2000, temperature: 0.9 };
    case 'definition': return { maxTokens: 800, temperature: 0.5 };
    case 'calculation': return { maxTokens: 300, temperature: 0.1 };
    case 'correction': return { maxTokens: 1000, temperature: 0.3 };
    default: return { maxTokens: 1000, temperature: 0.7 };
  }
}

/** Emotional tone guidance for system prompt. */
const TONE_GUIDANCE = {
  frustrated: 'The user seems frustrated. Be extra patient, acknowledge the difficulty, and be precise.',
  confused: 'The user seems confused. Start from basics, use analogies, go step by step.',
  excited: 'The user is excited! Match their energy while being accurate.',
  appreciative: 'The user appreciated something. Acknowledge it naturally, don\'t be overly modest.',
  curious: 'The user is curious. Encourage exploration, suggest related topics.',
};

/**
 * Layer 3: Execution
 * Builds dynamic system prompt and runs agent loop with filtered tools.
 */
async function execute(message, context, intent) {
  const { channelId, userId, userName, agentLoop } = context;

  // Build enhanced system prompt, passing memories from Layer 2 to avoid duplicate search
  const basePrompt = await getSystemPrompt(channelId, userId, message.content, intent.memoryContext);

  const promptParts = [basePrompt];

  // Multi-user awareness in threads
  const contextMessages = getContext(channelId);
  const participants = new Set();
  for (const msg of contextMessages) {
    if (msg.name) participants.add(msg.name);
  }
  if (participants.size > 1) {
    const names = [...participants].join(', ');
    promptParts.push(`\n## Thread Participants\nThis thread has multiple participants: ${names}. Address users by name when relevant. The current message is from ${userName}.`);
  }

  // Correction handling
  if (intent.intent === 'correction') {
    promptParts.push(`\n## Important\nThe user is correcting your previous response. Acknowledge the mistake gracefully and provide the corrected information. Don't be defensive.`);
  }

  // Emotional tone guidance
  if (intent.emotionalTone && TONE_GUIDANCE[intent.emotionalTone]) {
    promptParts.push(`\n## Emotional Context\n${TONE_GUIDANCE[intent.emotionalTone]}`);
  }

  // Add intent guidance
  if (intent.approach) {
    promptParts.push(`\n## Response Guidance\nThe user seems to want: ${intent.intent}. ${intent.approach}`);
  }
  if (intent.tone) {
    promptParts.push(`Aim for a ${intent.tone} tone.`);
  }
  if (intent.keyContext) {
    promptParts.push(`\n## Key Context\n${intent.keyContext}`);
  }

  // Wire user verbosity preference
  const userSettings = getUserSettings(userId);
  if (userSettings?.verbosity === 'concise') {
    promptParts.push('\n\nIMPORTANT: The user prefers concise responses. Be brief and to the point.');
  } else if (userSettings?.verbosity === 'detailed') {
    promptParts.push('\n\nThe user prefers detailed, thorough responses. Elaborate when helpful.');
  }

  const systemPrompt = promptParts.join('\n');
  logger.debug('Execute', `System prompt length: ${systemPrompt.length} chars (~${Math.ceil(systemPrompt.length / 4)} tokens est.)`);

  // Prefix context messages with usernames for multi-user clarity
  const enrichedContextMessages = contextMessages.map(msg => {
    if (msg.role === 'user' && msg.name && typeof msg.content === 'string') {
      return { ...msg, content: `${msg.name}: ${msg.content}` };
    }
    return msg;
  });

  // Get dynamic model params based on intent
  const modelParams = getModelParams(intent.intent);

  // Run agent loop
  if (agentLoop) {
    const agentContext = {
      userId,
      userName,
      channelId,
      guildId: context.guildId,
      generatedImages: [],
      modelParams, // pass dynamic params
      registry: context.toolRegistry, // Enable tool fallback chains (brave→tavily, tavily→brave)
    };

    const timeout = context.agentLoopTimeout || 60000;

    const result = await Promise.race([
      agentLoop.run(enrichedContextMessages, systemPrompt, agentContext),
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeout)),
    ]);

    logger.info('Execute', `Agent loop completed in ${result.iterations} iterations, ${result.toolsUsed.length} tools used`);
    if (result.toolsUsed.length > 0) {
      logger.debug('Execute', `Tools used: ${result.toolsUsed.join('; ')}`);
    }

    return {
      text: result.text || '',
      toolsUsed: result.toolsUsed,
      iterations: result.iterations,
      images: result.images || [],
    };
  }

  logger.info('Execute', 'No agent loop available, using simple generation fallback');
  // Fallback: no agent loop, use simple generation
  const { generateResponse } = require('../openai-client');
  const { getSoulConfig } = require('../soul');
  const soulConfig = getSoulConfig();

  const messages = [{ role: 'system', content: systemPrompt }, ...enrichedContextMessages];
  const text = await Promise.race([
    generateResponse(messages, { ...soulConfig, ...modelParams }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000)),
  ]);

  return { text, toolsUsed: [], iterations: 0, images: [] };
}

module.exports = { execute };
