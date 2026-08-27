/**
 * Query understanding — Phase 1, deterministic.
 *
 * Produces three things and never discards the first:
 *   1. the original query, which stays the primary match text
 *   2. structured constraints, each with a confidence
 *   3. capability text, the query with recognised constraint phrases removed
 *
 * Constraints at or above HARD_THRESHOLD filter before ranking. Below it they
 * stay soft and only shade the order, so a misread narrows results rather than
 * deleting the right answer.
 *
 * No model is called here. An LLM extractor can replace this module behind the
 * same return shape for queries this cannot parse; see README "Ablation".
 */

export const HARD_THRESHOLD = 0.8;

const ASSETS = ['USDC', 'EURC', 'XLM'];

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, fifteen: 15, twenty: 20, twentyfive: 25, fifty: 50
};

// Phrases consumed while extracting constraints, stripped from capability text
// so "USDC" and "two cents" do not compete with the capability inside matching.
function strip(text, spans) {
  let out = text;
  for (const s of spans) out = out.replace(s, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

export function understand(rawQuery) {
  const query = String(rawQuery || '').trim();
  const lower = query.toLowerCase();
  const constraints = {};
  const consumed = [];

  // ---- asset -------------------------------------------------------------
  for (const asset of ASSETS) {
    const re = new RegExp(`\\b${asset}\\b`, 'i');
    const m = query.match(re);
    if (m) {
      constraints.asset = { value: asset, confidence: 0.98, source: m[0] };
      consumed.push(m[0]);
      break;
    }
  }

  // ---- network -----------------------------------------------------------
  if (/\btestnet\b/i.test(lower)) {
    constraints.network = { value: 'stellar:testnet', confidence: 0.97, source: 'testnet' };
    consumed.push(/\btestnet\b/i);
  } else if (/\b(pubnet|mainnet)\b/i.test(lower)) {
    constraints.network = { value: 'stellar:pubnet', confidence: 0.96, source: 'pubnet' };
    consumed.push(/\b(pubnet|mainnet)\b/i);
  } else if (/\bstellar\b/i.test(lower)) {
    // "on Stellar" names the chain, not the network. Default to pubnet, but at
    // a confidence that still filters -- both networks are served and mixing
    // them returns results the caller cannot pay for.
    constraints.network = { value: 'stellar:pubnet', confidence: 0.9, source: 'stellar' };
    consumed.push(/\bstellar\b/i);
  }

  // ---- price ceiling -----------------------------------------------------
  // "$0.05" / "under 5 cents" / "below two cents" are explicit. "cheap" and
  // "low-cost" are real intent but not a number -- kept soft.
  let priceMatch;
  if ((priceMatch = query.match(/(?:under|below|less than|max(?:imum)?|up to|<)\s*\$?\s*([0-9]*\.?[0-9]+)\s*(?:usd|dollars?)?\b/i))) {
    constraints.maxPriceUsd = { value: Number(priceMatch[1]), confidence: 0.94, source: priceMatch[0] };
    consumed.push(priceMatch[0]);
  } else if ((priceMatch = query.match(/(?:under|below|less than|up to)?\s*([0-9]+|[a-z]+)\s*cents?\b/i))) {
    const word = priceMatch[1].toLowerCase();
    const n = /^[0-9]+$/.test(word) ? Number(word) : NUMBER_WORDS[word];
    if (n !== undefined) {
      // No explicit comparator ("two cents" vs "under two cents") reads as a
      // ceiling but less certainly.
      const explicit = /under|below|less than|up to/i.test(priceMatch[0]);
      constraints.maxPriceUsd = {
        value: n / 100,
        confidence: explicit ? 0.88 : 0.68,
        source: priceMatch[0].trim()
      };
      consumed.push(priceMatch[0]);
    }
  } else if (/\b(cheap|cheapest|low[- ]cost|inexpensive|affordable)\b/i.test(lower)) {
    const m = lower.match(/\b(cheap|cheapest|low[- ]cost|inexpensive|affordable)\b/i);
    constraints.maxPriceUsd = { value: 0.05, confidence: 0.42, source: m[0] };
    consumed.push(new RegExp(m[0], 'i'));
  }

  // ---- scheme ------------------------------------------------------------
  if (/\b(metered|per minute|per-minute|by usage|usage[- ]based)\b/i.test(lower)) {
    const m = lower.match(/\b(metered|per minute|per-minute|by usage|usage[- ]based)\b/i);
    constraints.scheme = { value: 'upto', confidence: 0.72, source: m[0] };
  }

  // ---- interface type ----------------------------------------------------
  if (/\bmcp\b/i.test(lower)) {
    constraints.type = { value: 'mcp', confidence: 0.93, source: 'mcp' };
    consumed.push(/\bmcp\b/i);
  } else if (/\b(rest|http)\s*(api|endpoint)?\b/i.test(lower)) {
    constraints.type = { value: 'http', confidence: 0.62, source: 'http api' };
  }

  // ---- capability --------------------------------------------------------
  // Filler that carries no capability signal. Removing it keeps the lexical
  // branch focused; the original query is still returned untouched.
  const capability = strip(query, consumed)
    .replace(/\b(find|get|a|an|the|me|some|service|services|api|apis|for|that|which|can|please|i need|looking for)\b/gi, ' ')
    .replace(/[,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const hard = {}, soft = {};
  for (const [k, v] of Object.entries(constraints)) {
    (v.confidence >= HARD_THRESHOLD ? hard : soft)[k] = v;
  }

  return {
    original: query,
    capability: capability || query,
    constraints,
    hard,
    soft,
    threshold: HARD_THRESHOLD
  };
}
