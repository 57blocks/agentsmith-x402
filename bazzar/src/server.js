/** HTTP endpoints for the Bazaar catalog and its MCP transport. */

import http from 'node:http';
import { buildUnderstood } from './query.js';
import { retrieve, withheldUnpayable } from './retrieval.js';
import * as callability from './callability.js';
import { upsert, ValidationError } from './ingest.js';
import { query, pool } from './db.js';
import { handleMcp } from './mcp/handler.js';
import { readJson } from './http-body.js';

const PORT = Number(process.env.PORT || 8402);
// Keep MCP on a separate port so it can be deployed and scaled independently.
const MCP_PORT = Number(process.env.MCP_PORT || 8406);
// Public origin advertised in the MCP metadata.
const BASE_URL = process.env.BASE_URL || `http://localhost:${MCP_PORT}`;
const MCP_URL = `${BASE_URL}/mcp`;
const X402_VERSION = 2;

// ---------------------------------------------------------------- helpers

function send(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, mcp-session-id',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'cache-control': 'no-store'
  });
  res.end(payload);
}

/** Map a catalog row to the discovery response shape. */
function present(row, understood) {
  const call = understood ? callability.analyze(row, understood) : null;
  return {
    resource_id: row.id,
    serviceName: row.service_name,
    description: row.description,
    tags: row.tags,
    type: row.type,
    resource: {
      url: row.resource_url,
      toolName: row.tool_name || undefined,
      transport: row.transport || undefined
    },
    accepts: [{
      scheme: row.scheme,
      network: row.network,
      asset: row.asset,
      maxAmountRequired: Number(row.price_usd).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''),
      payTo: row.pay_to
    }],
    output: row.output_structure ? { structure: row.output_structure } : undefined,
    input_parameters: row.input_params,
    ...(call ? { callability: call } : {}),
    ...(row.match !== undefined
      ? {
          match_score: Number(Number(row.match).toFixed(2)),
          soft_penalties: row.soft_penalties?.length ? row.soft_penalties : undefined
        }
      : {}),
    // Facts about the listing. Not inputs to the ranking score.
    facts: {
      settlements: row.settlements,
      last_settled_at: row.last_settled_at
    }
  };
}

// ---------------------------------------------------------------- routes

async function handleSearch(url, res) {
  // An absent query is a browse, not an error: no keywords asked for means
  // nothing is excluded and the whole catalog comes back. Filters still apply.
  const understood = buildUnderstood({
    query: url.searchParams.get('query') || '',
    network: url.searchParams.get('network'),
    asset: url.searchParams.get('asset'),
    type: url.searchParams.get('type'),
    scheme: url.searchParams.get('scheme'),
    maxPriceUsd: url.searchParams.get('maxPriceUsd')
  });

  const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
  const started = process.hrtime.bigint();

  const [{ candidates, keywords }, withheld, total] = await Promise.all([
    retrieve(understood),
    withheldUnpayable(understood),
    query('SELECT count(*)::int AS n FROM resources').then(({ rows }) => rows[0].n)
  ]);

  const ranked = candidates.slice(0, limit);

  const tookMs = Number(process.hrtime.bigint() - started) / 1e6;

  send(res, 200, {
    x402Version: X402_VERSION,
    // How the request was read. Returned so a caller never has to guess.
    parse: {
      original: understood.original,
      capability: understood.capability,
      constraints: Object.entries(understood.constraints).map(([name, c]) => ({
        name,
        value: c.value,
        confidence: c.confidence,
        applied: c.confidence >= understood.threshold ? 'filter' : 'soft',
        source: c.source
      })),
      hard_threshold: understood.threshold
    },
    resources: ranked.map((resource) => present(resource, understood)),
    // Matched the capability, cannot be paid for. Kept out of the ranked list,
    // but presented as full cards so the page can show each as an unavailable
    // listing — the reason it cannot be paid for rides along.
    withheld: withheld.map((resource) => ({
      ...present(resource, understood),
      payable: false,
      reason: resource.payable_reason
    })),
    pagination: { limit, returned: ranked.length, matched: candidates.length, catalog_total: total },
    // Recorded with every response so any result can be reproduced.
    retrieval_config: {
      configuration: 'keyword match — a listing needs one keyword that narrows the catalog',
      matching: 'case-insensitive regex at word boundary, over name+tags, description and parameters',
      conjunction: 'any selective keyword',
      keywords,
      ordering: 'field weight (name+tags 3, description 2, parameters 1), then settlements',
      took_ms: Number(tookMs.toFixed(1))
    }
  });
}

async function handleBrowse(url, res) {
  const where = ['1=1'];
  const params = [];
  for (const [param, col] of [['network', 'network'], ['asset', 'asset'], ['type', 'type'], ['scheme', 'scheme']]) {
    const v = url.searchParams.get(param);
    if (v && v !== 'All') { params.push(param === 'asset' ? v.toUpperCase() : v); where.push(`${col} = $${params.length}`); }
  }
  const payTo = url.searchParams.get('payTo');
  if (payTo) { params.push(payTo); where.push(`pay_to = $${params.length}`); }
  const maxPrice = url.searchParams.get('maxPriceUsd');
  if (maxPrice && maxPrice !== 'Any') { params.push(Number(maxPrice)); where.push(`price_usd <= $${params.length}`); }

  const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 100);
  const offset = Number(url.searchParams.get('offset')) || 0;

  const { rows } = await query(
    `SELECT * FROM resources WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params);
  const { rows: [{ n }] } = await query(
    `SELECT count(*)::int AS n FROM resources WHERE ${where.join(' AND ')}`, params);

  send(res, 200, {
    x402Version: X402_VERSION,
    resources: rows.map((resource) => present(resource, null)),
    pagination: { limit, offset, returned: rows.length, matched: n }
  });
}

/* Catalog facts and values used by the filter controls. */
async function handleStats(res) {
  const { rows: [agg] } = await query(`
    SELECT count(*)::int                                     AS resources,
           count(DISTINCT pay_to)::int                       AS sellers,
           count(DISTINCT network)::int                      AS networks,
           COALESCE(sum(settlements) FILTER (
             WHERE last_settled_at >= now() - interval '30 days'), 0)::int AS settlements_30d
    FROM resources`);

  const distinct = async (col) =>
    (await query(`SELECT DISTINCT ${col} AS v FROM resources WHERE ${col} IS NOT NULL ORDER BY 1`))
      .rows.map(({ v }) => v);

  send(res, 200, {
    x402Version: X402_VERSION,
    catalog: agg,
    filters: {
      type: await distinct('type'),
      network: await distinct('network'),
      asset: await distinct('asset'),
      // Only USDC rows have a USD comparison in the current catalog.
      price_usd: (await query("SELECT DISTINCT price_usd AS v FROM resources WHERE asset = 'USDC' ORDER BY 1"))
        .rows.map((r) => Number(r.v))
    }
  });
}

async function handleDetail(id, res) {
  const { rows } = await query('SELECT * FROM resources WHERE id = $1', [id]);
  if (!rows.length) return send(res, 404, { error: 'no such resource', code: 'not_found', resource_id: id });
  send(res, 200, { x402Version: X402_VERSION, resource: present(rows[0], null), raw: rows[0].raw_metadata });
}

async function handleRegister(req, res) {
  const body = await readJson(req);
  const listing = body.listing || body;
  const saved = await upsert(listing, {
    payable: body.payable ?? true,
    payable_reason: body.payable_reason ?? null
  });
  send(res, 201, {
    x402Version: X402_VERSION,
    bazaar: { status: 'success', resource_id: saved.id },
    resource: saved
  });
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, mcp-session-id',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' }); return res.end(); }

    if (req.method === 'GET' && url.pathname === '/health') {
      const { rows } = await query('SELECT count(*)::int AS n FROM resources');
      return send(res, 200, { ok: true, service: 'bazaar', catalog: rows[0].n });
    }
    if (req.method === 'GET' && url.pathname === '/discovery/search')    return await handleSearch(url, res);
    if (req.method === 'GET' && url.pathname === '/discovery/stats')     return await handleStats(res);
    if (req.method === 'GET' && url.pathname === '/discovery/resources') return await handleBrowse(url, res);
    if (req.method === 'GET' && url.pathname.startsWith('/discovery/resources/'))
      return await handleDetail(decodeURIComponent(url.pathname.split('/').pop()), res);
    if (req.method === 'POST' && url.pathname === '/discovery/register') return await handleRegister(req, res);

    send(res, 404, { error: 'no such route', code: 'not_found', path: url.pathname });
  } catch (err) {
    if (err instanceof ValidationError || err.status === 400) {
      return send(res, 400, { error: err.message, code: 'invalid_listing', field: err.field });
    }
    console.error('[bazaar]', err);
    send(res, 500, { error: 'internal error', code: 'internal', detail: err.message });
  }
});

// The MCP surface is its own HTTP server on its own port — it does not share the
// REST port. Every request on this port is handed to the MCP transport; CORS
// preflight is answered here too so browser-based MCP clients can reach it.
const mcpServer = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, mcp-session-id',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' }); return res.end(); }

    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/mcp') {
      return send(res, 404, { error: 'no such route', code: 'not_found', path: url.pathname });
    }
    // POST carries a JSON-RPC body the transport needs parsed; GET/DELETE are
    // the streamable protocol's own and take no body.
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    await handleMcp(req, res, body);
  } catch (err) {
    console.error('[bazaar mcp]', err);
    if (!res.headersSent) send(res, 500, { error: 'internal error', code: 'internal', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[bazaar] listening on http://localhost:${PORT}`);
  console.log(`[bazaar] db: ${process.env.DATABASE_URL || 'postgres://localhost:5432/bazaar'}`);
});

mcpServer.listen(MCP_PORT, () => {
  console.log(`[bazaar] MCP listening on ${MCP_URL}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => mcpServer.close(() => pool.end().then(() => process.exit(0))));
  });
}
