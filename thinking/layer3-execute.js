/**
 * @module thinking/layer3-execute
 * @description Execution layer that builds enhanced system prompts from intent
 * analysis and runs the agent loop with all available tools.
 */

const logger = require('../logger');
const { getSystemPrompt } = require('../soul');
const { getContext } = require('../context');

/**
 * Layer 3: Execution
 * Builds dynamic system prompt and runs agent loop with filtered tools.
 */
async function execute(message, context, intent) {
  const { channelId, userId, userName, agentLoop } = context;

  // Build enhanced system prompt
  const basePrompt = await getSystemPrompt(channelId, userId, message.content);

  const promptParts = [basePrompt];

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

  const systemPrompt = promptParts.join('\n');
  logger.debug('Execute', `System prompt length: ${systemPrompt.length} chars (~${Math.ceil(systemPrompt.length / 4)} tokens est.)`);
  const contextMessages = getContext(channelId);

  // Build tool filter from intent suggestions
  let toolFilter = null;
  if (intent.suggestedTools && intent.suggestedTools.length > 0) {
    const suggested = new Set(intent.suggestedTools);
    // Always include suggested tools, but also allow the model to use others
    // We pass the suggestion as a hint, not a hard filter
    toolFilter = null; // Let agent loop have access to all tools
  }

  // Run agent loop
  if (agentLoop) {
    const agentContext = {
      userId,
      userName,
      channelId,
      generatedImages: [],
    };

    const timeout = context.agentLoopTimeout || 60000;

    const result = await Promise.race([
      agentLoop.run(contextMessages, systemPrompt, agentContext),
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

  const messages = [{ role: 'system', content: systemPrompt }, ...contextMessages];
  const text = await Promise.race([
    generateResponse(messages, soulConfig),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 30000)),
  ]);

  return { text, toolsUsed: [], iterations: 0, images: [] };
}

module.exports = { execute };
