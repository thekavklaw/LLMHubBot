const logger = require('../logger');

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

/**
 * Search the web using Brave Search API.
 * @param {string} query
 * @param {number} count
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
async function searchWeb(query, count = 5) {
  if (!BRAVE_API_KEY) {
    logger.error('WebSearch', 'BRAVE_API_KEY not set');
    return [{ title: 'Error', url: '', snippet: 'Web search is not configured.' }];
  }

  try {
    const params = new URLSearchParams({ q: query, count: String(count) });
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    });

    if (!res.ok) {
      logger.error('WebSearch', `Brave API error: ${res.status}`);
      return [{ title: 'Error', url: '', snippet: `Search failed (${res.status})` }];
    }

    const data = await res.json();
    const results = (data.web?.results || []).slice(0, count).map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.description || '',
    }));

    return results.length > 0 ? results : [{ title: 'No results', url: '', snippet: 'No results found.' }];
  } catch (err) {
    logger.error('WebSearch', 'Error:', err);
    return [{ title: 'Error', url: '', snippet: err.message }];
  }
}

module.exports = { searchWeb };
