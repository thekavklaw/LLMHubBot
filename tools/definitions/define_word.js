const logger = require('../../logger');
const { withRetry } = require('../../utils/retry');
const LRUCache = require('../../utils/cache');

const wordCache = new LRUCache(200, 3600000); // 1 hour TTL

module.exports = {
  name: 'define_word',
  description: 'Look up the definition of an English word or term using a free dictionary API.',
  parameters: {
    type: 'object',
    properties: {
      word: { type: 'string', description: 'The word to define' },
    },
    required: ['word'],
  },
  async execute(args) {
    const wordKey = args.word.trim().toLowerCase();
    const cached = wordCache.get(wordKey);
    if (cached) return cached;

    const word = encodeURIComponent(wordKey);
    const res = await withRetry(() => fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`, {
      signal: AbortSignal.timeout(10000),
    }), { label: 'define-word' });

    if (!res.ok) {
      if (res.status === 404) return { word: args.word, found: false, message: 'Word not found in dictionary.' };
      throw new Error(`Dictionary API error: ${res.status}`);
    }

    const data = await res.json();
    const entry = data[0];
    const meanings = entry.meanings.slice(0, 3).map(m => ({
      partOfSpeech: m.partOfSpeech,
      definitions: m.definitions.slice(0, 2).map(d => ({
        definition: d.definition,
        example: d.example || null,
      })),
    }));

    const result = {
      word: entry.word,
      found: true,
      phonetic: entry.phonetic || null,
      meanings,
    };
    wordCache.set(wordKey, result);
    return result;
  },
  getCache() { return wordCache; },
};
