/** Generate ranked candidates from the searchable listing fields.
 * Selective keyword matching keeps common words from returning the whole catalog. */

import { query } from './db.js';

/** Words carrying no selective signal. Dropped before matching so a natural
 *  sentence is treated as the keywords inside it. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'for',
  'from', 'get', 'give', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it',
  'me', 'my', 'need', 'of', 'on', 'or', 'over', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'to', 'up', 'use', 'want', 'was',
  'what', 'when', 'which', 'who', 'will', 'with', 'would', 'you', 'your'
]);

/** Keep user input data, never regex syntax. */
const escapeRe = (s) => s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');

export function keywords(capability) {
  const toks = (String(capability ?? '').toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(toks)];
}

/** Apply hard constraints before ranking. */
function buildFilters(hard, params) {
  const where = ['payable = TRUE'];
  if (hard.network)     { params.push(hard.network.value);      where.push(`network = $${params.length}`); }
  if (hard.asset)       { params.push(hard.asset.value);        where.push(`asset = $${params.length}`); }
  if (hard.type)        { params.push(hard.type.value);         where.push(`type = $${params.length}`); }
  if (hard.scheme)      { params.push(hard.scheme.value);       where.push(`scheme = $${params.length}`); }
  if (hard.maxPriceUsd) {
    params.push(hard.maxPriceUsd.value);
    where.push(`asset = 'USDC' AND price_usd <= $${params.length}`);
  }
  return where;
}

const SELECT_COLS = `
  id, service_name, description, tags, input_params, output_params, output_structure,
  type, transport, network, asset, scheme, price_usd, resource_url, tool_name, pay_to,
  payable, payable_reason, settlements, last_settled_at, enrichment_metadata`;

/** Fraction of the catalog above which a keyword is treated as too common to
 *  select on. It still scores; it just cannot earn a slot alone. */
export const MAX_KEYWORD_DOC_FRACTION = 0.6;

const SEARCHABLE = `(search_title || ' ' || search_body || ' ' || search_params)`;

/* A keyword must occur in at least one row and no more than the configured
 * share of the catalog. Two matching rows are always allowed for REST/MCP pairs. */
const SELECTIVE_CTE = `
  WITH sel AS (
    SELECT t FROM unnest($1::text[]) AS t
    WHERE (SELECT count(*) FROM resources d WHERE d.${SEARCHABLE.slice(1, -1)} ~* ('\\m' || t))
          BETWEEN 1 AND GREATEST(2, (SELECT count(*) FROM resources) * ${MAX_KEYWORD_DOC_FRACTION})
  )`;

/* Names and tags carry more signal than descriptions, which carry more than
 * parameter text. Score every keyword, including non-selective ones. */
const MATCH_SCORE = `(
  SELECT COALESCE(sum(
      CASE WHEN search_title  ~* ('\\m' || t) THEN 3 ELSE 0 END
    + CASE WHEN search_body   ~* ('\\m' || t) THEN 2 ELSE 0 END
    + CASE WHEN search_params ~* ('\\m' || t) THEN 1 ELSE 0 END
  ), 0)
  FROM unnest($1::text[]) AS t
)`;

/** At least one selective keyword must appear in the listing. */
const MATCH_ANY_SELECTIVE = `EXISTS (
  SELECT 1 FROM sel WHERE resources.${SEARCHABLE.slice(1, -1)} ~* ('\\m' || sel.t)
)`;

export async function retrieve(understood) {
  const kws = keywords(understood.capability).map(escapeRe);

  // No keywords: nothing was asked for, so nothing is excluded.
  const params = kws.length ? [kws] : [];
  const where = buildFilters(understood.hard, params);
  if (kws.length) where.push(MATCH_ANY_SELECTIVE);

  const { rows } = await query(`
    ${kws.length ? SELECTIVE_CTE : ''}
    SELECT ${SELECT_COLS}, ${kws.length ? MATCH_SCORE : '0'} AS score
    FROM resources
    WHERE ${where.join(' AND ')}
    ORDER BY score DESC, settlements DESC, service_name ASC`, params);

  return {
    candidates: applySoftSignals(rows.map((resource) => ({ ...resource, match: Number(resource.score) })), understood.soft),
    keywords: kws
  };
}

/** Low-confidence constraints affect order but never remove a candidate. */
export function applySoftSignals(rows, soft) {
  return rows
    .map((resource) => {
      const penalties = [];
      let factor = 1;
      if (soft.maxPriceUsd && Number(resource.price_usd) > soft.maxPriceUsd.value) {
        factor *= 0.55;
        penalties.push({
          signal: 'maxPriceUsd',
          detail: `priced at $${Number(resource.price_usd).toFixed(3)}, above the $${soft.maxPriceUsd.value} ceiling read at ${soft.maxPriceUsd.confidence} confidence`
        });
      }
      if (soft.scheme && resource.scheme !== soft.scheme.value) {
        factor *= 0.8;
        penalties.push({ signal: 'scheme', detail: `scheme is ${resource.scheme}, not ${soft.scheme.value}` });
      }
      if (soft.type && resource.type !== soft.type.value) {
        factor *= 0.85;
        penalties.push({ signal: 'type', detail: `interface is ${resource.type}, not ${soft.type.value}` });
      }
      return { ...resource, match: resource.match * factor, soft_penalties: penalties };
    })
    .sort((a, b) => b.match - a.match);
}

/** Resources that matched the keywords but cannot be paid for. Returned
 *  separately from the ranked list, never inside it. */
export async function withheldUnpayable(understood) {
  const kws = keywords(understood.capability).map(escapeRe);

  /* An empty search is a browse: every unpayable listing is withheld, not just
   * the ones a keyword selected. Without this the page shows 8 payable
   * listings while the header counts 20 in the catalog, and the 12 missing
   * ones are unaccounted for. */
  const params = kws.length ? [kws] : [];
  const where = ['payable = FALSE'];
  if (kws.length) where.push(MATCH_ANY_SELECTIVE);
  if (understood.hard.network) { params.push(understood.hard.network.value); where.push(`network = $${params.length}`); }
  if (understood.hard.type)    { params.push(understood.hard.type.value);    where.push(`type = $${params.length}`); }

  const { rows } = await query(`
    ${kws.length ? SELECTIVE_CTE : ''}
    SELECT ${SELECT_COLS}, ${kws.length ? MATCH_SCORE : '0'} AS score
    FROM resources
    WHERE ${where.join(' AND ')}
    ORDER BY score DESC, service_name ASC
    LIMIT 50`, params);
  // Carry the score under `match` too, so a withheld row can go through the same
  // present() path as a payable one and render as a full card.
  return rows.map((resource) => ({ ...resource, match: Number(resource.score) }));
}
