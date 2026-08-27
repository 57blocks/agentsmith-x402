/** Validate a listing and build the fields used by the search index. */

import { createHash } from 'node:crypto';
import { query } from './db.js';

class ValidationError extends Error {
  constructor(msg, field) { super(msg); this.field = field; this.status = 400; }
}

const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

/** Structural checks mirroring schemas/listing.schema.json plus the bazaar
 *  extension's sanitization rules. Invalid optional fields are dropped rather
 *  than failing the listing; invalid required fields reject it. */
export function validate(listing) {
  if (!listing || typeof listing !== 'object') throw new ValidationError('listing must be an object');
  const { resource, info, accepts } = listing;

  if (!resource?.url) throw new ValidationError('resource.url is required', 'resource.url');
  let url;
  try { url = new URL(resource.url); } catch { throw new ValidationError('resource.url must be an absolute URL', 'resource.url'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError('resource.url must be http or https', 'resource.url');

  if (!resource.description) throw new ValidationError('resource.description is required', 'resource.description');
  if (!info?.input?.type) throw new ValidationError('info.input.type is required', 'info.input.type');
  if (!['http', 'mcp'].includes(info.input.type)) throw new ValidationError('info.input.type must be http or mcp', 'info.input.type');
  if (info.input.type === 'mcp' && !info.input.toolName) throw new ValidationError('info.input.toolName is required for mcp', 'info.input.toolName');
  if (info.input.type === 'mcp' && !info.input.inputSchema) throw new ValidationError('info.input.inputSchema is required for mcp', 'info.input.inputSchema');
  if (!Array.isArray(accepts) || accepts.length === 0) throw new ValidationError('accepts must be a non-empty array', 'accepts');

  const primaryRequirement = accepts[0];
  for (const field of ['scheme', 'network', 'asset', 'maxAmountRequired', 'payTo']) {
    if (!primaryRequirement[field]) {
      throw new ValidationError(`accepts[0].${field} is required`, `accepts[0].${field}`);
    }
  }
  if (!['exact', 'upto'].includes(primaryRequirement.scheme)) {
    throw new ValidationError('accepts[0].scheme must be exact or upto', 'accepts[0].scheme');
  }

  // Optional fields: sanitize per spec rather than reject.
  let serviceName = resource.serviceName;
  if (serviceName && (!PRINTABLE_ASCII.test(serviceName) || serviceName.length > 32)) serviceName = serviceName.slice(0, 32);

  let tags = Array.isArray(resource.tags) ? resource.tags : [];
  tags = [...new Set(tags.filter((t) => typeof t === 'string' && t.length <= 32 && PRINTABLE_ASCII.test(t)).map((t) => t.toLowerCase()))].slice(0, 5);

  return { serviceName: serviceName || url.hostname, tags };
}

/** Flatten a JSON Schema properties block into [{name, description, required}]. */
function paramsFromSchema(schema) {
  if (!schema?.properties) return [];
  const required = new Set(schema.required || []);
  return Object.entries(schema.properties).map(([name, spec]) => ({
    name,
    description: spec?.description || null,
    type: spec?.type || null,
    required: required.has(name)
  }));
}

export function project(listing) {
  const { serviceName, tags } = validate(listing);
  const { resource, info, accepts } = listing;
  const primaryRequirement = accepts[0];

  const inputSchema = info.input.type === 'mcp' ? info.input.inputSchema : info.input.schema;
  const inputParams = paramsFromSchema(inputSchema);
  const outputParams = paramsFromSchema(info.output?.schema);

  // Deterministic normalization: canonical network id, uppercase asset symbol,
  // amount as a USD-comparable number.
  const network = String(primaryRequirement.network).toLowerCase().replace(/^stellar$/, 'stellar:pubnet');
  const asset = String(primaryRequirement.asset).toUpperCase();
  const priceUsd = Number(primaryRequirement.maxAmountRequired);
  if (!Number.isFinite(priceUsd)) {
    throw new ValidationError(
      'accepts[0].maxAmountRequired must be numeric',
      'accepts[0].maxAmountRequired',
    );
  }

  // Hash rather than an encoding of the URL: base64 of the URL itself shares a
  // prefix between any two services on the same host, so truncating it
  // collides (http://localhost:8403/ocr vs http://localhost:8404/extract).
  const id = `${info.input.type}_${createHash('sha256')
    .update(`${resource.url}|${info.input.toolName || ''}`)
    .digest('base64url')
    .slice(0, 16)}`;

  // Weighted search bands. Flattened here rather than at query time because a
  // generated column cannot contain a subquery over the jsonb arrays.
  const paramText = [...inputParams, ...outputParams]
    .map((p) => [p.name, p.description].filter(Boolean).join(' '))
    .join(' ');

  return {
    search_title: [serviceName, tags.join(' ')].filter(Boolean).join(' '),
    search_body: [resource.description, info.output?.structure, info.input.description].filter(Boolean).join(' '),
    search_params: paramText,
    id,
    raw_metadata: listing,
    normalized_metadata: {
      network, asset, price_usd: priceUsd, scheme: primaryRequirement.scheme,
      service_name: serviceName, tags,
      normalized_at: new Date().toISOString(),
      normalizer_version: '1'
    },
    enrichment_metadata: null,
    enrichment_version: null,
    service_name: serviceName,
    description: resource.description,
    tags,
    input_params: inputParams,
    output_params: outputParams,
    output_structure: info.output?.structure || info.output?.format || info.output?.type || null,
    type: info.input.type,
    transport: info.input.transport || null,
    network,
    asset,
    scheme: primaryRequirement.scheme,
    price_usd: priceUsd,
    resource_url: resource.url,
    tool_name: info.input.toolName || null,
    pay_to: primaryRequirement.payTo
  };
}

export async function upsert(listing, extra = {}) {
  const projected = project(listing);
  const sql = `
    INSERT INTO resources (
      id, raw_metadata, normalized_metadata, enrichment_metadata, enrichment_version,
      service_name, description, tags, input_params, output_params, output_structure,
      search_title, search_body, search_params,
      type, transport, network, asset, scheme, price_usd,
      resource_url, tool_name, pay_to, payable, payable_reason, settlements, last_settled_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
    ON CONFLICT (resource_url, COALESCE(tool_name, '')) DO UPDATE SET
      raw_metadata = EXCLUDED.raw_metadata,
      normalized_metadata = EXCLUDED.normalized_metadata,
      service_name = EXCLUDED.service_name,
      description = EXCLUDED.description,
      tags = EXCLUDED.tags,
      input_params = EXCLUDED.input_params,
      output_params = EXCLUDED.output_params,
      output_structure = EXCLUDED.output_structure,
      search_title = EXCLUDED.search_title,
      search_body = EXCLUDED.search_body,
      search_params = EXCLUDED.search_params,
      price_usd = EXCLUDED.price_usd,
      payable = EXCLUDED.payable,
      payable_reason = EXCLUDED.payable_reason,
      updated_at = now()
    RETURNING id, service_name, type, network, asset, price_usd, payable`;

  const { rows } = await query(sql, [
    projected.id, projected.raw_metadata, projected.normalized_metadata, projected.enrichment_metadata, projected.enrichment_version,
    projected.service_name, projected.description, projected.tags, JSON.stringify(projected.input_params), JSON.stringify(projected.output_params), projected.output_structure,
    projected.search_title, projected.search_body, projected.search_params,
    projected.type, projected.transport, projected.network, projected.asset, projected.scheme, projected.price_usd,
    projected.resource_url, projected.tool_name, projected.pay_to,
    extra.payable ?? true, extra.payable_reason ?? null,
    extra.settlements ?? 0, extra.last_settled_at ?? null
  ]);
  return rows[0];
}

export { ValidationError };
