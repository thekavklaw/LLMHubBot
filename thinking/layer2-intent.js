const logger = require('../logger');
const { thinkWithModel } = require('../openai-client');
const { searchMemory } = require('../memory');
const { getProfile, formatProfileForPrompt } = require('../users');

/**
 * Layer 2: Intent Analysis
 * Determines what the user wants and how to approach it.
 */
async function analyzeIntent(message, context, gate) {
  const content = typeof message.content === 'string' ? message.content : '[media]';
  const { userId, userName, channelId } = context;

  // Gather context in parallel
  const [memories, profile] = await Promise.all([
    searchMemory(content, 3, 0.6).catch(() => []),
    Promise.resolve(getProfile(userId)).catch(() => null),
  ]);

  const profileStr = profile ? formatProfileForPrompt(userId) : '';
  const memoriesStr = memories.length > 0
    ? memories.map(m => `- ${m.content}`).join('\n')
    : '';

  // Get available tool names for context
  const toolNames = context.toolRegistry
    ? context.toolRegistry.listTools().map(t => `${t.name}: ${t.description}`).join('\n')
    : '';

  const intentModel = process.env.INTENT_MODEL || 'gpt-4.1-mini';

  try {
    const result = await thinkWithModel([
      {
        role: 'system',
        content: `Analyze user intent for a Discord AI bot response. Available tools:\n${toolNames || 'none'}\n\nReturn JSON:
{
  "intent": "question|request|creative|discussion|greeting|help|image_request",
  "suggestedTools": ["tool_name"],
  "tone": "educational|casual|technical|witty|helpful",
  "includeImage": false,
  "keyContext": "relevant context to include in response",
  "approach": "brief guidance on how to respond"
}`,
      },
      {
        role: 'user',
        content: `User: ${userName}\n${profileStr ? `Profile: ${profileStr}\n` : ''}${memoriesStr ? `Memories:\n${memoriesStr}\n` : ''}Message: "${content.slice(0, 500)}"`,
      },
    ], intentModel);

    const parsed = JSON.parse(result);

    return {
      intent: parsed.intent || 'discussion',
      suggestedTools: Array.isArray(parsed.suggestedTools) ? parsed.suggestedTools : [],
      tone: parsed.tone || 'helpful',
      includeImage: !!parsed.includeImage,
      memoryContext: memories,
      userContext: profile,
      keyContext: parsed.keyContext || '',
      approach: parsed.approach || '',
    };
  } catch (err) {
    logger.error('Intent', 'Analysis error:', err.message);
    return {
      intent: 'discussion',
      suggestedTools: [],
      tone: 'helpful',
      includeImage: false,
      memoryContext: memories,
      userContext: profile,
      keyContext: '',
      approach: '',
    };
  }
}

module.exports = { analyzeIntent };
