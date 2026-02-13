const logger = require('../../logger');
const config = require('../../config');
const OpenAI = require('openai');

// SSRF protection: block private/internal IPs
const BLOCKED_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/0\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/169\.254\./,
  /^file:/i,
  /^ftp:/i,
];

module.exports = {
  name: 'summarize_url',
  description: 'Fetch and summarize the content of a web page. Useful for quickly understanding articles or documentation.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch and summarize' },
    },
    required: ['url'],
  },
  timeout: 30000,
  async execute(args) {
    const url = args.url.trim();

    // Validate URL format
    if (!/^https?:\/\/.+/i.test(url)) throw new Error('Invalid URL: must start with http:// or https://');
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(url)) throw new Error('Blocked: cannot access internal/private URLs');
    }

    // Fetch with limits
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'LLMHub-Bot/1.0 (summarizer)' },
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) throw new Error(`HTTP ${res.status} fetching URL`);

    // Read max 50KB of text
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/') && !contentType.includes('application/json')) {
      throw new Error('URL does not return text content');
    }

    const buffer = await res.arrayBuffer();
    const text = new TextDecoder().decode(buffer.slice(0, 50 * 1024));

    // Strip HTML tags for basic extraction
    const cleaned = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);

    if (cleaned.length < 50) throw new Error('Page has too little text content to summarize');

    // Summarize with AI
    const openai = new OpenAI({ apiKey: config.openaiApiKey });
    const completion = await openai.chat.completions.create({
      model: config.miniModel,
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'Summarize the following web page content concisely in 2-4 paragraphs. Focus on key points.' },
        { role: 'user', content: cleaned },
      ],
    });

    return {
      url,
      summary: completion.choices[0].message.content,
    };
  },
};
