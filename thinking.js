const OpenAI = require('openai');
const logger = require('./logger');
const config = require('./config');

const openai = new OpenAI({ apiKey: config.openaiApiKey });

const THINKING_PROMPT = `You are the internal reasoning system for LLMHub, a Discord AI assistant. Analyze the latest message in context and decide how to respond.

Consider:
- Is this message directed at the bot or relevant enough to respond to?
- Would an image enhance the response? (diagrams, visualizations, creative requests)
- Does this need a web search for current information?
- What tone is appropriate?
- What do you know about this user from their profile?

Return ONLY valid JSON:
{
  "action": "respond" | "respond_with_image" | "generate_image" | "search_and_respond" | "ignore",
  "reasoning": "brief internal reasoning",
  "response_approach": "how to frame the response",
  "image_prompt": "detailed image generation prompt if action involves image, null otherwise",
  "search_query": "search query if action is search_and_respond, null otherwise",
  "tone": "helpful" | "educational" | "casual" | "technical" | "witty",
  "confidence": 0.0-1.0
}

Rules:
- In threads: bias toward responding (user started the thread to chat)
- In main channel: only respond if genuinely relevant
- Generate images when: user asks to visualize/show/draw something, a diagram would help explain, creative/artistic request
- Search when: question about current events, facts you're unsure about, time-sensitive info
- "ignore" when: casual banter between humans, emoji-only, someone already answered`;

const VALID_ACTIONS = new Set(['respond', 'respond_with_image', 'generate_image', 'search_and_respond', 'ignore']);
const VALID_TONES = new Set(['helpful', 'educational', 'casual', 'technical', 'witty']);

const DEFAULT_DECISION = {
  action: 'respond',
  reasoning: 'Default fallback — could not parse thinking result',
  response_approach: 'Be helpful and concise',
  image_prompt: null,
  search_query: null,
  tone: 'helpful',
  confidence: 0.5,
};

/**
 * Run the thinking layer to decide how to handle a message.
 * @param {Array} messages - Recent context messages [{role, content, name}]
 * @param {Object} userProfile - User profile data
 * @param {Array} relevantMemories - Relevant memories for this context
 * @param {boolean} isThread - Whether this is in a thread
 * @param {string} botId - The bot's Discord user ID
 * @returns {Object} Decision object
 */
async function think(messages, userProfile, relevantMemories, isThread, botId) {
  try {
    const thinkingModel = process.env.THINKING_MODEL || config.miniModel || 'gpt-4.1-mini';

    // Build context string from recent messages
    const contextStr = messages.slice(-10).map(m => {
      const name = m.name || m.role;
      const content = typeof m.content === 'string' ? m.content : '[media message]';
      return `${name}: ${content}`;
    }).join('\n');

    // Build user profile context
    let profileStr = '';
    if (userProfile) {
      const parts = [];
      if (userProfile.display_name) parts.push(`Display name: ${userProfile.display_name}`);
      if (userProfile.interests) parts.push(`Known interests: ${userProfile.interests}`);
      if (userProfile.image_gen_count) parts.push(`Images generated for this user: ${userProfile.image_gen_count}`);
      if (parts.length > 0) profileStr = `\nUser profile:\n${parts.join('\n')}`;
    }

    // Build memories context
    let memoriesStr = '';
    if (relevantMemories && relevantMemories.length > 0) {
      memoriesStr = `\nRelevant memories:\n${relevantMemories.map(m => `- ${m.content}`).join('\n')}`;
    }

    const systemContent = `${THINKING_PROMPT}

Context: ${isThread ? 'This is a thread (bias toward responding)' : 'This is the main channel (only respond if relevant)'}
Bot ID: <@${botId}>${profileStr}${memoriesStr}`;

    const response = await openai.chat.completions.create({
      model: thinkingModel,
      temperature: 0.2,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: `Recent conversation:\n${contextStr}\n\nDecide what action to take for the latest message.` },
      ],
    });

    const text = response.choices[0]?.message?.content || '';
    const decision = JSON.parse(text);

    // Validate and sanitize
    const result = {
      action: VALID_ACTIONS.has(decision.action) ? decision.action : 'respond',
      reasoning: decision.reasoning || 'No reasoning provided',
      response_approach: decision.response_approach || 'Be helpful',
      image_prompt: decision.image_prompt || null,
      search_query: decision.search_query || null,
      tone: VALID_TONES.has(decision.tone) ? decision.tone : 'helpful',
      confidence: Math.min(1, Math.max(0, parseFloat(decision.confidence) || 0.5)),
    };

    // Ensure image_prompt exists for image actions
    if ((result.action === 'respond_with_image' || result.action === 'generate_image') && !result.image_prompt) {
      result.action = 'respond';
      result.image_prompt = null;
    }

    // Ensure search_query exists for search action
    if (result.action === 'search_and_respond' && !result.search_query) {
      result.action = 'respond';
      result.search_query = null;
    }

    logger.info('Thinking', `Decision: action=${result.action} tone=${result.tone} confidence=${result.confidence} — ${result.reasoning}`);
    return result;
  } catch (err) {
    logger.error('Thinking', 'Error:', err.message);
    return { ...DEFAULT_DECISION };
  }
}

module.exports = { think };
