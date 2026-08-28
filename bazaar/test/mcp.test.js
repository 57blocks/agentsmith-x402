import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readJson } from '../src/http-body.js';
import { handleMcp } from '../src/mcp/handler.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let server, base;

before(async () => {
  server = http.createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    await handleMcp(req, res, body);
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/mcp`;
});

after(() => server.close());

async function connect() {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base)));
  return client;
}

test('search_services returns available first, unavailable at the tail', async () => {
  const client = await connect();
  const res = await client.callTool({ name: 'search_services', arguments: { query: 'translate' } });
  const { results, matched, unavailable } = res.structuredContent;

  assert.ok(results.length > 0, 'has results');
  assert.equal(results.filter((r) => r.available).length, matched);
  assert.equal(results.filter((r) => !r.available).length, unavailable);

  const firstUnavailable = results.findIndex((r) => !r.available);
  if (firstUnavailable !== -1) {
    assert.ok(results.slice(firstUnavailable).every((r) => !r.available), 'unavailable are all at the tail');
  }
  for (const r of results.filter((r) => !r.available)) assert.ok(r.reason, 'reason present');

  await client.close();
});

test('type filter is applied', async () => {
  const client = await connect();
  const res = await client.callTool({ name: 'search_services', arguments: { query: 'translate', type: 'mcp' } });
  for (const r of res.structuredContent.results.filter((r) => r.available)) {
    assert.equal(r.type, 'mcp');
  }
  await client.close();
});
