const OpenAI = require('openai');
const { searchWeb } = require('./tools/webSearch');
const logger = require('./logger');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search_web',
    description: 'Search the internet for current information, news, facts, or anything the user asks about that may require up-to-date data.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query'],
    },
  },
};

/**
 * Generate a chat completion response.
 * Content can be a string or an array (for vision messages).
 * Supports function calling (web search).
 * @param {Array} messages - OpenAI message array
 * @param {Object} config - {model, temperature, maxTokens}
 * @returns {string} response text
 */
async function generateResponse(messages, config = {}) {
  try {
    const useTools = config.tools !== false;
    const params = {
      model: config.model || 'gpt-5.2',
      messages,
      temperature: config.temperature ?? 0.8,
      max_tokens: config.maxTokens || 1000,
    };

    if (useTools) {
      params.tools = [SEARCH_TOOL];
      params.tool_choice = 'auto';
    }

    let completion = await openai.chat.completions.create(params);
    let responseMsg = completion.choices[0]?.message;

    // Handle tool calls (max 3 iterations)
    let iterations = 0;
    while (responseMsg?.tool_calls && iterations < 3) {
      iterations++;
      // Add the assistant message with tool calls
      messages.push(responseMsg);

      for (const toolCall of responseMsg.tool_calls) {
        if (toolCall.function.name === 'search_web') {
          let args;
          try { args = JSON.parse(toolCall.function.arguments); } catch { args = { query: '' }; }
          logger.info('OpenAI', `Tool call: search_web("${args.query}")`);
          const results = await searchWeb(args.query);
          const resultText = results.map(r => `**${r.title}**\n${r.url}\n${r.snippet}`).join('\n\n');
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultText,
          });
        }
      }

      completion = await openai.chat.completions.create(params);
      responseMsg = completion.choices[0]?.message;
    }

    return responseMsg?.content || '';
  } catch (err) {
    if (err.status === 429) {
      logger.error('OpenAI', 'Rate limited:', err.message);
      return "I'm being rate limited right now — try again in a moment.";
    }
    logger.error('OpenAI', 'Error:', err.message);
    throw err;
  }
}

/**
 * Generate an image using DALL-E / gpt-image-1.
 * @param {string} prompt
 * @param {string} size - e.g. '1024x1024'
 * @returns {Buffer} image buffer
 */
async function generateImage(prompt, size = '1024x1024') {
  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt,
    size,
    n: 1,
  });

  // gpt-image-1 returns base64 by default
  const imageData = response.data[0];
  if (imageData.b64_json) {
    return Buffer.from(imageData.b64_json, 'base64');
  }
  // If URL, download it
  if (imageData.url) {
    const res = await fetch(imageData.url);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error('No image data returned');
}

module.exports = { generateResponse, generateImage };
