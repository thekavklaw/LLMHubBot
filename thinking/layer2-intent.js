/**
 * @module thinking/layer2-intent
 * @description Analyzes user intent using fast heuristics (no LLM call),
 * gathers relevant context (memories, user profile, settings) for downstream layers.
 */

const logger = require('../logger');
const { hybridSearch } = require('../memory');
const { getProfile, formatProfileForPrompt } = require('../users');
const { getUserSettings, getUserProfile } = require('../db');

// ── Return-user tracking (in-memory last_seen map) ──
const lastSeenMap = new Map();

/**
 * Detect emotional tone from message content.
 */
function detectTone(content) {
  const lower = content.toLowerCase();
  if (/(!{2,}|😡|🤬|wtf|ugh|frustrated|annoying|broken|doesn't work|still wrong)/i.test(lower)) return 'frustrated';
  if (/(\?{2,}|confused|don't understand|what do you mean|huh|lost)/i.test(lower)) return 'confused';
  if (/(thanks|thank you|awesome|perfect|great|love it|🎉|❤️|😊)/i.test(lower)) return 'appreciative';
  if (/(wow|amazing|incredible|cool|😮|🤯)/i.test(lower)) return 'excited';
  if (/(\?$|curious|wondering|how does|why does|tell me about)/i.test(lower)) return 'curious';
  return 'neutral';
}

/**
 * Check for negation patterns that should suppress an intent.
 * E.g., "don't generate an image" should NOT trigger image_request.
 */
function hasNegation(text, keywordMatch) {
  if (!keywordMatch) return false;
  const idx = text.indexOf(keywordMatch);
  if (idx < 0) return false;
  // Check for negation words in the 30 chars before the keyword
  const prefix = text.slice(Math.max(0, idx - 30), idx).toLowerCase();
  return /\b(don'?t|do not|no|never|stop|without|aren'?t|isn'?t|shouldn'?t|can'?t|cannot|won'?t)\b/.test(prefix);
}

/**
 * Fast heuristic intent classification — no LLM call needed.
 * Uses multi-word patterns and negation awareness.
 */
function classifyIntent(messageContent, previousIntent) {
  const lower = messageContent.toLowerCase();

  // Negation-aware image requests
  const imageMatch = lower.match(/\b(draw|paint|generate an? image|create an? image|show me|visualize|imagine|picture of|make an? image)\b/);
  if (imageMatch && !hasNegation(lower, imageMatch[0])) {
    return { intent: 'image_request', tone: 'creative' };
  }

  // Correction (check early — high priority)
  if (/\b(that's wrong|you'?re wrong|actually,? (?:it |that |no |the )|no,? that|incorrect|try again|not right|that'?s not)\b/i.test(lower)) {
    return { intent: 'correction', tone: 'receptive' };
  }

  // Creative writing requests
  if (/\b(write (?:me )?a (?:story|poem|song|haiku|limerick)|tell me a story|creative writ|once upon a time|write (?:a |an )?(?:essay|article|blog))\b/i.test(lower)) {
    return { intent: 'creative', tone: 'creative' };
  }

  // Summarize (standalone, not URL)
  if (/\b(tl;?dr|summarize|sum up|give me (?:a |the )?(?:summary|gist|overview)|in short)\b/i.test(lower)) {
    // URL summarization
    if (/https?:\/\/\S+/.test(lower)) {
      return { intent: 'summarize_url', tone: 'concise' };
    }
    return { intent: 'summarize', tone: 'concise' };
  }

  // Code requests — multi-word patterns + context-aware
  const codePatterns = /\b(write (?:a |an |the |some )?(?:code|function|script|program|algorithm)|run (?:this |the )?code|execute|debug|fix (?:this |the |my )?(?:code|bug|error)|python|javascript|typescript|how do I (?:code|implement|program)|help me (?:with |write )?(?:code|a function|a script)|algorithm)\b/i;
  if (codePatterns.test(lower)) {
    return { intent: 'code_request', tone: 'technical' };
  }
  // Context-aware: if previous intent was code, ambiguous follow-ups continue as code
  if (previousIntent === 'code_request' && /\b(now|also|and|then|next|what about|how about|change|modify|update|add)\b/i.test(lower)) {
    return { intent: 'code_request', tone: 'technical' };
  }

  // Questions about current events
  if (/\b(latest|recent(?:ly)?|today(?:'s)?|current|news|what happened|what'?s (?:new|happening|going on))\b/i.test(lower)) {
    return { intent: 'current_info', tone: 'informative', suggestSearch: true };
  }

  // Definitions — multi-word patterns
  if (/\b(what (?:is|are) (?:a |an |the )?|define|meaning of|what does .+ mean|explain (?:what |how )?|can you (?:explain|tell me (?:about|what)))\b/i.test(lower)) {
    return { intent: 'definition', tone: 'educational' };
  }

  // Math
  if (/\b(calculate|compute|solve|what is \d|how much is|convert \d)\b/i.test(lower)) {
    return { intent: 'calculation', tone: 'precise' };
  }

  // General help patterns — detect intent from phrasing
  if (/\b(help me (?:with|understand|figure out)|can you (?:help|assist)|I need (?:help|assistance|you to)|how do I|how can I|I want to|I'?d like to)\b/i.test(lower)) {
    // These are general help requests — keep as 'general' but with helpful tone
    return { intent: 'general', tone: 'helpful' };
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

  // Heuristic classification (instant, no LLM) — pass previous intent for context awareness
  const previousIntent = context._lastIntent || null;
  const classification = classifyIntent(content, previousIntent);
  const emotionalTone = detectTone(content);

  // Gather context in parallel
  const [memories, profile] = await Promise.all([
    hybridSearch(content, 5, 0.55, context.guildId).catch(() => []),
    Promise.resolve(getProfile(userId)).catch(() => null),
  ]);

  // Return-user detection: check if 24h+ since last interaction
  let returnUserContext = '';
  const now = Date.now();
  const lastSeen = lastSeenMap.get(userId);
  const hoursSinceLastSeen = lastSeen ? (now - lastSeen) / 3600000 : Infinity;
  lastSeenMap.set(userId, now);

  if (hoursSinceLastSeen >= 24 && memories.length > 0) {
    const recentTopics = memories.slice(0, 3).map(m => m.content).join('; ');
    const daysAway = Math.floor(hoursSinceLastSeen / 24);
    returnUserContext = `This user last interacted ${daysAway} day(s) ago. Their recent topics were: ${recentTopics}. Consider naturally referencing past context if relevant, but don't force it.`;
    logger.info('Intent', `Return user detected: ${userName} (${daysAway}d away)`);
  }

  logger.info('Intent', `Heuristic intent="${classification.intent}", tone="${classification.tone}", emotion="${emotionalTone}", memories=${memories.length}, profile=${profile ? 'found' : 'none'}`);

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
  if (classification.intent === 'summarize') suggestedTools.push('summarize_url');
  // creative intent doesn't need special tools — uses main model

  // Store intent for context-aware classification on next message
  context._lastIntent = classification.intent;

  return {
    intent: classification.intent,
    suggestedTools,
    tone: classification.tone,
    emotionalTone,
    includeImage: classification.intent === 'image_request',
    memoryContext: memories,
    userContext: profile,
    userSettings,
    keyContext: returnUserContext,
    approach: '',
  };
}

module.exports = { analyzeIntent, classifyIntent, detectTone };
