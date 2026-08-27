import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    FACILITATOR_STELLAR_PRIVATE_KEY: 'S_TEST_ONLY',
    FACILITATOR_API_KEY: 'test-resource-server-token',
    ...overrides,
  };
}

describe('facilitator configuration', () => {
  it('defaults to an authenticated testnet facilitator', () => {
    const config = loadConfig(env());
    expect(config.network).toBe('stellar:testnet');
    expect(config.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(config.apiKey).toBe('test-resource-server-token');
    expect(config.maxTransactionFeeStroops).toBe(50_000);
  });

  it('requires authentication on testnet too', () => {
    expect(() => loadConfig(env({ FACILITATOR_API_KEY: '' }))).toThrow(/API_KEY/);
  });

  it('fails closed when no signer configuration exists', () => {
    expect(() => loadConfig({})).toThrow(/PRIVATE_KEY/);
  });

  it('requires fee-bump and channel account configuration together', () => {
    expect(() => loadConfig(env({
      FACILITATOR_STELLAR_FEE_BUMP_SECRET: 'S_FEE',
    }))).toThrow(/must be set together/);
  });

  it('accepts fee-bump and channel mode without a single-signer key', () => {
    const config = loadConfig({
      FACILITATOR_STELLAR_FEE_BUMP_SECRET: 'S_FEE',
      FACILITATOR_STELLAR_CHANNEL_SECRETS: 'S_ONE, S_TWO',
      FACILITATOR_API_KEY: 'test-resource-server-token',
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.channelSecrets).toEqual(['S_ONE', 'S_TWO']);
  });

  it('requires authentication on pubnet by default', () => {
    expect(() => loadConfig(env({
      STELLAR_NETWORK: 'stellar:pubnet',
      STELLAR_RPC_URL: 'https://rpc.example.com',
      FACILITATOR_API_KEY: '',
    }))).toThrow(/API_KEY/);
    expect(loadConfig(env({
      STELLAR_NETWORK: 'stellar:pubnet',
      FACILITATOR_API_KEY: 'server-secret',
      STELLAR_RPC_URL: 'https://rpc.example.com',
    })).apiKey).toBe('server-secret');
  });

  it('requires an explicit RPC provider on pubnet', () => {
    expect(() => loadConfig(env({
      STELLAR_NETWORK: 'stellar:pubnet',
      FACILITATOR_API_KEY: 'server-secret',
    }))).toThrow(/STELLAR_RPC_URL/);
  });

  it('rejects unsupported networks and insecure remote RPC URLs', () => {
    expect(() => loadConfig(env({ STELLAR_NETWORK: 'eip155:84532' }))).toThrow(/STELLAR_NETWORK/);
    expect(() => loadConfig(env({ STELLAR_RPC_URL: 'http://rpc.example.com' }))).toThrow(/HTTPS/);
  });
});
