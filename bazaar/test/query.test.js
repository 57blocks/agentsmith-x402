import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnderstood } from '../src/query.js';

test('explicit filters become hard constraints at full confidence', () => {
  const u = buildUnderstood({ query: 'translate text', asset: 'usdc', network: 'stellar:pubnet' });
  assert.equal(u.hard.asset.value, 'USDC');
  assert.equal(u.hard.asset.confidence, 1);
  assert.equal(u.hard.network.value, 'stellar:pubnet');
  assert.equal(u.soft.asset, undefined);
});

test("'All' and 'Any' are ignored", () => {
  const u = buildUnderstood({ query: 'ocr', type: 'All', maxPriceUsd: 'Any' });
  assert.equal(u.hard.type, undefined);
  assert.equal(u.hard.maxPriceUsd, undefined);
});

test('maxPriceUsd becomes a numeric hard ceiling', () => {
  const u = buildUnderstood({ query: 'ocr', maxPriceUsd: '0.05' });
  assert.equal(u.hard.maxPriceUsd.value, 0.05);
  assert.equal(u.hard.maxPriceUsd.confidence, 1);
});

test('maxPriceUsd of 0 is a legitimate ceiling, not "no filter"', () => {
  const u = buildUnderstood({ query: 'ocr', maxPriceUsd: '0' });
  assert.equal(u.hard.maxPriceUsd.value, 0);
});

test('explicit filter replaces a parsed constraint for the same key', () => {
  const u = buildUnderstood({ query: 'ocr', type: 'mcp' });
  assert.equal(u.hard.type.value, 'mcp');
  assert.equal(u.hard.type.confidence, 1);
});

test('the Weather showcase query selects the USDC testnet catalog', () => {
  const u = buildUnderstood({ query: 'current METAR weather report, USDC, Stellar testnet' });
  assert.equal(u.hard.asset.value, 'USDC');
  assert.equal(u.hard.network.value, 'stellar:testnet');
});
