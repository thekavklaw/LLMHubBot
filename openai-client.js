const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate a chat completion response.
 * @param {Array} messages - OpenAI message array
 * @param {Object} config - {model, temperature, maxTokens}
 * @returns {string} response text
 */
async function generateResponse(messages, config = {}) {
  try {
    const completion = await openai.chat.completions.create({
      model: config.model || 'gpt-4o',
      messages,
      temperature: config.temperature ?? 0.8,
      max_tokens: config.maxTokens || 1000,
    });
    return completion.choices[0]?.message?.content || '';
  } catch (err) {
    if (err.status === 429) {
      console.error('[OpenAI] Rate limited:', err.message);
      return 'I\'m being rate limited right now — try again in a moment.';
    }
    console.error('[OpenAI] Error:', err.message);
    throw err;
  }
}

module.exports = { generateResponse };
