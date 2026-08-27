import { describe, expect, it, vi } from 'vitest';
import { SettlementCoordinator, settlementKey } from '../src/settlement-coordinator.js';

describe('SettlementCoordinator', () => {
  it('builds the same key regardless of object key ordering', () => {
    expect(settlementKey({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(settlementKey({ a: { c: 3, d: 4 }, b: 2 }));
  });

  it('does not cache failed settlement responses', async () => {
    const coordinator = new SettlementCoordinator(1_000, 10);
    const operation = vi.fn(async () => ({
      success: false as const,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: 'stellar:testnet',
    }));
    await coordinator.run('key', operation);
    await coordinator.run('key', operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
