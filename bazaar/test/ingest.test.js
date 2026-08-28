import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UPSERT_SQL } from '../src/ingest.js';

test('re-registering a resource updates its payment terms', () => {
  for (const field of ['type', 'transport', 'network', 'asset', 'scheme', 'pay_to']) {
    assert.match(UPSERT_SQL, new RegExp(`${field} = EXCLUDED\\.${field}`));
  }
});
