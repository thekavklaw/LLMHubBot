const logger = require('../logger');
const { thinkWithModel } = require('../openai-client');
const { storeMemory } = require('../memory');
const { appendUserNotes } = require('../users');
const { reflectAndUpdate } = require('../soul');

let reflectionCount = 0;

/**
 * Layer 5: Async Reflection
 * Runs after response is sent. Extracts learnings, updates user profiles, stores memories.
 */
async function reflect(message, response, context) {
  const content = typeof message.content === 'string' ? message.content : '[media]';
  const { userId, userName, channelId } = context;
  const responseText = response.text || '';

  if (content.length < 10 && responseText.length < 10) return;

  reflectionCount++;
  const reflectionInterval = parseInt(process.env.REFLECTION_INTERVAL || '5', 10);

  try {
    const intentModel = process.env.INTENT_MODEL || 'gpt-4.1-mini';

    const result = await thinkWithModel([
      {
        role: 'system',
        content: `Extract learnings from this bot conversation. Return JSON:
{
  "userFacts": ["fact about the user"],
  "topics": ["topic discussed"],
  "toolsHelpful": true/false,
  "memoryWorthStoring": "key fact to remember long-term, or null"
}
Only include genuinely useful insights. Skip trivial exchanges.`,
      },
      {
        role: 'user',
        content: `User ${userName}: "${content.slice(0, 300)}"\nBot response: "${responseText.slice(0, 300)}"${response.toolsUsed?.length ? `\nTools used: ${response.toolsUsed.join(', ')}` : ''}`,
      },
    ], intentModel);

    const parsed = JSON.parse(result);

    // Update user profile with new facts
    if (parsed.userFacts && Array.isArray(parsed.userFacts) && userId) {
      for (const fact of parsed.userFacts) {
        if (fact && fact.length > 5) {
          appendUserNotes(userId, fact);
        }
      }
    }

    // Store memorable facts in RAG
    if (parsed.memoryWorthStoring) {
      await storeMemory(parsed.memoryWorthStoring, {
        userId,
        userName,
        channelId,
        category: 'reflection',
      });
    }

    // Store topics
    if (parsed.topics && Array.isArray(parsed.topics)) {
      for (const topic of parsed.topics.slice(0, 2)) {
        if (topic && topic.length > 3) {
          await storeMemory(`${userName} discussed: ${topic}`, {
            userId,
            userName,
            channelId,
            category: 'topic',
          });
        }
      }
    }

    // Periodic soul reflection
    if (reflectionCount % reflectionInterval === 0) {
      logger.info('Reflect', `Triggering soul reflection (every ${reflectionInterval} reflections)`);
      await reflectAndUpdate();
    }

    logger.debug('Reflect', `Processed reflection for ${userName}: ${JSON.stringify(parsed).slice(0, 100)}`);
  } catch (err) {
    logger.error('Reflect', 'Reflection error:', err.message);
  }
}

module.exports = { reflect };
