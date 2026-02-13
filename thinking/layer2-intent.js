/**
 * @module thinking/layer2-intent
 * @description Analyzes user intent using fast heuristics (no LLM call),
 * gathers relevant context (memories, user profile, settings) for downstream layers.
 */

const logger = require('../logger');
const { searchMemory } = require('../memory');
const { getProfile, formatProfileForPrompt } = require('../users');
const { getUserSettings } = require('../db');

/**
 * Fast heuristic intent classification — no LLM call needed.
 */
function classifyIntent(messageContent) {
  const lower = messageContent.toLowerCase();

  // Image requests
  if (/\b(draw|paint|generate|create|show me|visualize|imagine|picture of)\b/i.test(lower)) {
    return { intent: 'image_request', tone: 'creative' };
  }
  // Code requests
  if (/\b(run|execute|code|python|javascript|function|algorithm)\b/i.test(lower)) {
    return { intent: 'code_request', tone: 'technical' };
  }
  // Questions about current events
  if (/\b(latest|recent|today|current|news|what happened)\b/i.test(lower)) {
    return { intent: 'current_info', tone: 'informative', suggestSearch: true };
  }
  // Definitions
  if (/\b(what is|what are|define|meaning of|what does .+ mean)\b/i.test(lower)) {
    return { intent: 'definition', tone: 'educational' };
  }
  // Math
  if (/\b(calculate|compute|solve|what is \d|how much is)\b/i.test(lower)) {
    return { intent: 'calculation', tone: 'precise' };
  }
  // URL summarization
  if (/https?:\/\/\S+/.test(lower) && /\b(summarize|summary|tldr|what does this say)\b/i.test(lower)) {
    return { intent: 'summarize_url', tone: 'concise' };
  }
  // Correction
  if (/\b(that's wrong|you're wrong|actually|no,? that|incorrect|try again|not right)\b/i.test(lower)) {
    return { intent: 'correction', tone: 'receptive' };
  }
  // Default
  return { intent: 'general', tone: 'helpful' };
}

/**
 * Layer 2: Intent Analysis
 * Uses heuristics for classification, still loads user profile and memories.
 */
async function analyzeIntent(message, context, gate) {
  const content = typeof message.content === 'string' ? message.content : '[media]';
  const { userId, userName, channelId } = context;

  // Heuristic classification (instant, no LLM)
  const classification = classifyIntent(content);

  // Gather context in parallel
  const [memories, profile] = await Promise.all([
    searchMemory(content, 3, 0.65).catch(() => []),
    Promise.resolve(getProfile(userId)).catch(() => null),
  ]);

  logger.info('Intent', `Heuristic intent="${classification.intent}", tone="${classification.tone}", memories=${memories.length}, profile=${profile ? 'found' : 'none'}`);

  // Load user settings
  const userSettings = getUserSettings(userId);

  // Build suggested tools from intent
  const suggestedTools = [];
  if (classification.intent === 'image_request') suggestedTools.push('generate_image');
  if (classification.intent === 'code_request') suggestedTools.push('code_runner');
  if (classification.intent === 'current_info' || classification.suggestSearch) suggestedTools.push('brave_search', 'tavily_search');
  if (classification.intent === 'definition') suggestedTools.push('define_word');
  if (classification.intent === 'calculation') suggestedTools.push('calculator');
  if (classification.intent === 'summarize_url') suggestedTools.push('summarize_url');

  return {
    intent: classification.intent,
    suggestedTools,
    tone: classification.tone,
    includeImage: classification.intent === 'image_request',
    memoryContext: memories,
    userContext: profile,
    userSettings,
    keyContext: '',
    approach: '',
  };
}

module.exports = { analyzeIntent, classifyIntent };
