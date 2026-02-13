const { generateResponse } = require('./openai-client');
const config = require('./config');
const logger = require('./logger');

const decisionCache = new Map();
const CACHE_TTL = 5000;

const PURE_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;
const LOW_VALUE = /^(lol|lmao|nice|ok|yeah|yep|nah|true|fr|facts|damn|rip|gg|bruh|haha|heh|wow|same|mood|based|real|bet|w|l|f|oof|hmm|idk|nvm|ty|thx|thanks|np|mb|gl|ez|cap|sus|slay|fire|lit|vibe|word|tru|yea|ya|ye|nope|welp|aight|ayo|sheesh|deadass|no cap|for real|i see|got it|makes sense|fair enough|good point|interesting)$/i;

async function shouldRespond(message, recentMessages, botId) {
  const content = message.content.trim();
  const mentionsBot = message.mentions?.has(botId);
  const repliesToBot = message.reference?.messageId &&
    message.channel.messages?.cache?.get(message.reference.messageId)?.author?.id === botId;

  if (mentionsBot || repliesToBot) {
    return { respond: true, confidence: 1.0, reason: 'Bot mentioned or replied to' };
  }

  if (content.length < 3 || PURE_EMOJI.test(content) || LOW_VALUE.test(content)) {
    return { respond: false, confidence: 0.95, reason: 'Low-value or trivial message' };
  }

  const cached = decisionCache.get(message.id);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { respond: cached.respond, confidence: cached.confidence, reason: cached.reason };
  }

  const contextStr = recentMessages.slice(-8).map(m => `${m.name || m.role}: ${m.content}`).join('\n');

  try {
    const prompt = `You're deciding if "LLMHub" bot should respond to the latest message in a Discord group chat about AI/LLMs.

Recent conversation:
${contextStr}

Latest message from ${message.author.username}: "${content}"

Rules:
- Respond if: it's a question (especially about AI/tech), someone needs help, the conversation invites the bot's input, or the bot can add genuine value
- Don't respond if: it's casual banter between humans, someone already answered, it's off-topic small talk, the conversation is flowing fine without the bot
- Lean towards NOT responding — quality over quantity

Return ONLY valid JSON: {"respond": true/false, "confidence": 0.0-1.0, "reason": "brief explanation"}`;

    const result = await generateResponse(
      [{ role: 'user', content: prompt }],
      { model: config.miniModel, maxTokens: 100, temperature: 0.1 }
    );

    const jsonMatch = result.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const decision = JSON.parse(jsonMatch[0]);
      const out = {
        respond: !!decision.respond,
        confidence: Math.min(1, Math.max(0, parseFloat(decision.confidence) || 0.5)),
        reason: decision.reason || 'GPT decision',
      };
      decisionCache.set(message.id, { ...out, timestamp: Date.now() });
      if (decisionCache.size > 100) {
        const now = Date.now();
        for (const [k, v] of decisionCache) {
          if (now - v.timestamp > CACHE_TTL) decisionCache.delete(k);
        }
      }
      return out;
    }
  } catch (err) {
    logger.error('Relevance', 'Error:', err);
  }

  return { respond: false, confidence: 0.3, reason: 'Fallback — could not determine' };
}

module.exports = { shouldRespond };
