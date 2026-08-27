/** Report which required inputs can be inferred from the search request. */

const SYNONYMS = {
  file: ['file', 'document', 'pdf', 'scan', 'scanned', 'image', 'photo', 'picture', 'page', 'upload', 'attachment'],
  url: ['url', 'link', 'address', 'uri', 'endpoint'],
  image: ['image', 'photo', 'picture', 'scan', 'png', 'jpg', 'jpeg'],
  text: ['text', 'string', 'content', 'body', 'passage'],
  city: ['city', 'town', 'place', 'location'],
  lang: ['language', 'lang', 'locale', 'english', 'chinese', 'spanish', 'french', 'german'],
  currency: ['currency', 'usd', 'eur', 'usdc', 'eurc'],
  date: ['date', 'day', 'today', 'tomorrow', 'yesterday', 'week', 'month'],
  latitude: ['latitude', 'lat', 'coordinate', 'coordinates', 'gps'],
  longitude: ['longitude', 'lon', 'lng', 'coordinate', 'coordinates', 'gps'],
  query: ['query', 'search', 'keyword', 'term']
};

function tokens(s) {
  return new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
}

function resolvable(param, queryTokens) {
  const name = String(param.name || '').toLowerCase();
  const nameParts = name.split(/[^a-z0-9]+/).filter(Boolean);

  // direct name match, including snake_case / camelCase components
  if (nameParts.some((p) => queryTokens.has(p))) return true;

  // synonym match on the parameter name
  for (const [key, words] of Object.entries(SYNONYMS)) {
    if (name.includes(key) && words.some((w) => queryTokens.has(w))) return true;
  }

  // the parameter's own description naming a concept present in the request
  const desc = tokens(param.description);
  let overlap = 0;
  for (const t of desc) if (t.length > 3 && queryTokens.has(t)) overlap++;
  return overlap >= 2;
}

export function analyze(resource, understood) {
  const qTokens = tokens(`${understood.original} ${understood.capability}`);
  const params = Array.isArray(resource.input_params) ? resource.input_params : [];
  const required = params.filter((p) => p.required);

  const unresolved = required.filter((p) => !resolvable(p, qTokens));
  const resolved = required.filter((p) => resolvable(p, qTokens));

  return {
    required_parameters: required.map((p) => p.name),
    resolved_from_request: resolved.map((p) => p.name),
    unfilled_required_parameters: unresolved.map((p) => ({
      name: p.name,
      description: p.description || null
    })),
    // Small and bounded. A fully unresolvable service still ranks; it is
    // reported, not excluded.
    weight: required.length === 0 ? 1 : 1 - 0.12 * (unresolved.length / required.length)
  };
}
