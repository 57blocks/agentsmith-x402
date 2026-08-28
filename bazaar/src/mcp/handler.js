/** Stateless MCP search surface backed by the same retrieval used by REST. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { buildUnderstood } from '../query.js';
import { retrieve, withheldUnpayable } from '../retrieval.js';
import { presentResult } from './present.js';

const inputSchema = {
  query: z.string().describe('Natural-language description of the capability to find'),
  type: z.enum(['http', 'mcp', 'sdk']).optional().describe('Interface type filter'),
  network: z.string().optional().describe('Settlement network, e.g. stellar:pubnet or eip155:84532'),
  asset: z.string().optional().describe('Settlement asset, e.g. USDC'),
  maxPriceUsd: z.number().optional().describe('Only services priced at or below this (USD)'),
  limit: z.number().int().positive().max(100).optional().describe('Max available results (default 20)')
};

async function runSearch(args) {
  const started = process.hrtime.bigint();
  const understood = buildUnderstood(args);
  const limit = Math.min(args.limit || 20, 100);

  const [retrieved, unavailable] = await Promise.all([
    retrieve(understood),
    withheldUnpayable(understood)
  ]);
  const available = retrieved.candidates;

  const shownAvailable = available.slice(0, limit);
  const results = [
    ...shownAvailable.map((resource) => presentResult(resource, true)),
    ...unavailable.map((resource) => presentResult(resource, false))
  ];
  const took_ms = Number(process.hrtime.bigint() - started) / 1e6;

  const line = (resource) => `- ${resource.name} — $${resource.price_usd} — ${resource.url}${resource.available ? '' : `  [unavailable: ${resource.reason}]`}`;
  const head = shownAvailable.length < available.length
    ? `${shownAvailable.length} of ${available.length} available`
    : `${available.length} available`;
  const text = results.length
    ? `${head}, ${unavailable.length} unavailable:\n${results.map(line).join('\n')}`
    : 'No services matched.';

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      results,
      matched: shownAvailable.length,
      total_available: available.length,
      unavailable: unavailable.length,
      took_ms
    }
  };
}

function buildServer() {
  const server = new McpServer({ name: 'agentsmith-bazaar', version: '0.1.0' });
  server.registerTool(
    'search_services',
    {
      description: 'Search the Bazaar catalog for agent-callable services. Returns matching services ranked by relevance, available (payable) ones first and unavailable ones at the end (each with the reason it cannot be paid for).',
      inputSchema
    },
    async (args) => runSearch(args)
  );
  return server;
}

/** Returns a node:http request handler for /mcp. `body` is the parsed JSON for
 *  POST (undefined for GET/DELETE, which the transport handles for streaming). */
export async function handleMcp(req, res, body) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
