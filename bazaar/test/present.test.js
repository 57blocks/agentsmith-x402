import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presentResult } from '../src/mcp/present.js';

const row = {
  id: 'http_abc', service_name: 'DocScan OCR', description: 'OCR on scans',
  tags: ['ocr', 'text'], type: 'http', resource_url: 'http://localhost:8403/ocr',
  tool_name: null, network: 'stellar:pubnet', asset: 'USDC', price_usd: '0.004',
  match: 6, payable_reason: null
};

test('available row maps to available:true, no reason', () => {
  const r = presentResult(row, true);
  assert.equal(r.available, true);
  assert.equal(r.name, 'DocScan OCR');
  assert.equal(r.url, 'http://localhost:8403/ocr');
  assert.equal(r.price_usd, 0.004);
  assert.equal(r.network, 'stellar:pubnet');
  assert.equal(r.match_score, 6);
  assert.equal(r.reason, undefined);
  assert.equal('toolName' in r, false);
});

test('unavailable row carries available:false and reason', () => {
  const r = presentResult({ ...row, payable_reason: 'provider_not_configured — X missing' }, false);
  assert.equal(r.available, false);
  assert.equal(r.reason, 'provider_not_configured — X missing');
});
