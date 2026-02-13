const logger = require('../logger');
const { thinkWithModel } = require('../openai-client');
const { withRetry } = require('../utils/retry');

const PURE_EMOJI = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u;
const LOW_VALUE = /^(lol|lmao|nice|ok|yeah|yep|nah|true|fr|facts|damn|rip|gg|bruh|haha|heh|wow|same|mood|based|real|bet|w|l|f|oof|hmm|idk|nvm|ty|thx|thanks|np|mb|gl|ez|cap|sus|slay|fire|lit|vibe|word|tru|yea|ya|ye|nope|welp|aight|ayo|sheesh|deadass|no cap|for real|i see|got it|makes sense|fair enough|good point|interesting)$/i;

/**
 * Layer 1: Relevance Gate
 * FAST heuristics first, LLM fallback only when inconclusive.
 * Target: <50ms heuristic, <500ms LLM.
 */
async function relevanceGate(message, context) {
  const content = (typeof message.content === 'string' ? message.content : '').trim();
  const { botId, inThread, channelId, gptChannelId, mentionsBot, repliesToBot } = context;

  // ── Heuristic: Always engage ──
  if (mentionsBot) {
    logger.info('Gate', `Heuristic match: "bot mentioned" for ${context.userName}`);
    return { engage: true, reason: 'Bot mentioned', confidence: 1.0 };
  }
  if (repliesToBot) {
    logger.info('Gate', `Heuristic match: "reply to bot" for ${context.userName}`);
    return { engage: true, reason: 'Reply to bot message', confidence: 1.0 };
  }
  if (inThread) {
    logger.info('Gate', `Heuristic match: "thread message" for ${context.userName}`);
    return { engage: true, reason: 'In /chat thread', confidence: 0.95 };
  }

  // ── Heuristic: Never engage ──
  if (content.length < 3) {
    logger.debug('Gate', `Heuristic match: "too short" (${content.length} chars)`);
    return { engage: false, reason: 'Message too short', confidence: 0.95 };
  }
  if (PURE_EMOJI.test(content)) {
    logger.debug('Gate', 'Heuristic match: "pure emoji"');
    return { engage: false, reason: 'Pure emoji', confidence: 0.95 };
  }
  if (LOW_VALUE.test(content)) {
    logger.debug('Gate', `Heuristic match: "low-value filler" ("${content}")`);
    return { engage: false, reason: 'Low-value filler', confidence: 0.9 };
  }

  // ── Heuristic: Likely engage ──
  if (channelId === gptChannelId && content.endsWith('?')) {
    logger.info('Gate', 'Heuristic match: "question in #gpt channel"');
    return { engage: true, reason: 'Question in #gpt channel', confidence: 0.8 };
  }

  // ── LLM fallback for ambiguous cases ──
  logger.info('Gate', `No heuristic matched, falling back to LLM for: "${content.slice(0, 60)}"`);
  try {
    const gateModel = process.env.GATE_MODEL || 'gpt-4.1-mini';
    const result = await withRetry(() => thinkWithModel([
      {
        role: 'system',
        content: 'Decide if a Discord AI bot should respond. Return JSON: {"engage":true/false,"reason":"brief","confidence":0.0-1.0}. Bias toward NOT responding unless the message invites bot input.',
      },
      {
        role: 'user',
        content: `Message from ${context.userName}: "${content.slice(0, 200)}"`,
      },
    ], gateModel), { label: 'gate-llm', maxRetries: 2 });

    const parsed = JSON.parse(result);
    const gateResult = {
      engage: !!parsed.engage,
      reason: parsed.reason || 'LLM decision',
      confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.5)),
    };
    logger.info('Gate', `LLM fallback result: engage=${gateResult.engage}, reason="${gateResult.reason}", confidence=${gateResult.confidence}`);
    return gateResult;
  } catch (err) {
    logger.error('Gate', 'LLM fallback error:', { error: err.message, stack: err.stack });
    // Conservative: don't engage on error
    return { engage: false, reason: 'Gate error — defaulting to ignore', confidence: 0.3 };
  }
}

module.exports = { relevanceGate };
