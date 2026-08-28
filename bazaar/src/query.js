/**
 * Turn a query string plus explicit filter values into an `understood` object.
 *
 * Single source of truth for both the REST search handler and the MCP tool.
 * Filters passed explicitly (network/asset/type/scheme/maxPriceUsd) are treated
 * as caller-asserted and override anything parsed from the text at full
 * confidence. 'All' / 'Any' / empty mean "no filter".
 */
import { understand } from './query-understanding.js';

// UI sentinels for an inactive filter. Treating them here keeps REST and MCP
// callers consistent and avoids coercing values such as "All" to NaN.
const OFF = new Set(['', 'All', 'Any', undefined, null]);

export function buildUnderstood({ query = '', network, asset, type, scheme, maxPriceUsd } = {}) {
  const understood = understand(String(query).trim());

  for (const [key, raw] of [['network', network], ['asset', asset], ['type', type], ['scheme', scheme]]) {
    if (OFF.has(raw)) continue;
    const value = key === 'asset' ? String(raw).toUpperCase() : raw;
    understood.constraints[key] = { value, confidence: 1, source: 'explicit filter' };
    understood.hard[key] = understood.constraints[key];
    delete understood.soft[key];
  }

  if (!OFF.has(maxPriceUsd)) {
    understood.constraints.maxPriceUsd = { value: Number(maxPriceUsd), confidence: 1, source: 'explicit filter' };
    understood.hard.maxPriceUsd = understood.constraints.maxPriceUsd;
    delete understood.soft.maxPriceUsd;
  }

  return understood;
}
