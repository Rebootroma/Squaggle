// Keenable web search. Uses KEENABLE_API_KEY when set, otherwise the keyless /public endpoint.
const BASE = 'https://api.keenable.ai';
const APP_TITLE = process.env.KEENABLE_APP_TITLE || 'facetime-quote-agent';

export async function search(query, { mode = 'realtime', max_results = 6, site } = {}) {
  const key = process.env.KEENABLE_API_KEY;
  const path = key ? '/v1/search' : '/v1/search/public';
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['X-API-Key'] = key; else headers['X-Keenable-Title'] = APP_TITLE;
  const body = { query, mode, max_results };
  if (site) body.site = site;
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Keenable ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return { endpoint: path, keyed: Boolean(key), ...json };
}

const PRICE_RE = /\$\s?(\d{1,4}(?:,\d{3})?(?:\.\d{2})?)/g;

function pricesIn(text) {
  const out = [];
  for (const m of (text || '').matchAll(PRICE_RE)) {
    const v = Number(m[1].replace(/,/g, ''));
    if (v >= 1 && v <= 5000) out.push(v);
  }
  return out;
}

/**
 * Search for a part and pull candidate prices out of the result snippets.
 * Returns the best (lowest plausible) price with its source URL, plus all candidates.
 */
export async function searchPartPrice(partQuery, opts = {}) {
  const q = /price/i.test(partQuery) ? partQuery : `${partQuery} price`;
  const data = await search(q, { mode: 'realtime', max_results: 8, ...opts });
  const candidates = [];
  for (const r of data.results || []) {
    const prices = pricesIn(`${r.title} ${r.description} ${r.snippet}`);
    if (!prices.length) continue;
    // A snippet can list several prices (list vs sale). Keep the lowest as the buy price.
    const price = Math.min(...prices);
    candidates.push({
      title: r.title,
      url: r.url,
      price,
      all_prices: prices,
      acquired_at: r.acquired_at,
      snippet: (r.snippet || r.description || '').replace(/\s+/g, ' ').slice(0, 240),
    });
  }
  candidates.sort((a, b) => a.price - b.price);
  // Prefer the lowest price that is not an outlier (>40% below the median), so a "$2.99 shipping" line doesn't win.
  let best = null;
  if (candidates.length) {
    const median = candidates[Math.floor(candidates.length / 2)].price;
    best = candidates.find(c => c.price >= median * 0.6) || candidates[0];
  }
  return {
    query: q,
    endpoint: data.endpoint,
    keyed: data.keyed,
    result_count: (data.results || []).length,
    best,
    candidates: candidates.slice(0, 5),
  };
}

// CLI: node keenable.mjs "Moen 1225 cartridge"
import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  searchPartPrice(process.argv.slice(2).join(' ') || 'Moen 1225 cartridge').then(r => console.log(JSON.stringify(r, null, 2)), e => { console.error(e); process.exit(1); });
}
