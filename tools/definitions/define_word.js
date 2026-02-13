const logger = require('../../logger');
const { withRetry } = require('../../utils/retry');

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
    const word = encodeURIComponent(args.word.trim().toLowerCase());
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

    return {
      word: entry.word,
      found: true,
      phonetic: entry.phonetic || null,
      meanings,
    };
  },
};
