import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import { createApp } from '../src/app.js';
import type { FacilitatorConfig } from '../src/config.js';
import type { PaymentEngine } from '../src/engine.js';
import type { Logger } from '../src/logger.js';

const requirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  amount: '10000',
  asset: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
  payTo: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};

const body = {
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    accepted: requirements,
    payload: { authorization: 'AAAA', signature: 'BBBB' },
  },
  paymentRequirements: requirements,
};

const apiKey = 'test-resource-server-token';

function config(overrides: Partial<FacilitatorConfig> = {}): FacilitatorConfig {
  return {
    port: 8407,
    host: '127.0.0.1',
    nodeEnv: 'test',
    network: 'stellar:testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    privateKey: 'S_TEST_ONLY',
    channelSecrets: [],
    apiKey,
    maxTransactionFeeStroops: 50_000,
    maxBodySize: '256kb',
    rateLimitWindowMs: 60_000,
    rateLimitMax: 10_000,
    settlementCacheTtlMs: 300_000,
    settlementCacheMaxEntries: 100,
    trustProxy: ['loopback'],
    corsOrigins: '*',
    shutdownTimeoutMs: 10_000,
    ...overrides,
  };
}

function engine(overrides: Partial<PaymentEngine> = {}): PaymentEngine {
  return {
    verify: vi.fn(async () => ({ isValid: true, payer: requirements.payTo } as VerifyResponse)),
    settle: vi.fn(async () => ({
      success: true,
      payer: requirements.payTo,
      transaction: 'abc123',
      network: 'stellar:testnet',
    } as SettleResponse)),
    supported: vi.fn(() => ({
      kinds: [{
        x402Version: 2,
        scheme: 'exact',
        network: 'stellar:testnet',
        extra: { areFeesSponsored: true },
      }],
      extensions: [],
      signers: { 'stellar:*': ['GFACILITATOR'] },
    } as SupportedResponse)),
    ...overrides,
  };
}

const silentLogger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('Stellar facilitator HTTP interface', () => {
  it('publishes health without any secret material', async () => {
    const response = await request(createApp({ config: config(), engine: engine(), log: silentLogger }))
      .get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      service: 'agentsmith-stellar-facilitator',
      network: 'stellar:testnet',
    });
    expect(JSON.stringify(response.body)).not.toContain('S_TEST_ONLY');
  });

  it('returns the standard sponsored Stellar kind from /supported', async () => {
    const response = await request(createApp({ config: config(), engine: engine(), log: silentLogger }))
      .get('/supported')
      .set('authorization', `Bearer ${apiKey}`);
    expect(response.status).toBe(200);
    expect(response.body.kinds[0]).toEqual({
      x402Version: 2,
      scheme: 'exact',
      network: 'stellar:testnet',
      extra: { areFeesSponsored: true },
    });
    expect(response.body.signers).toEqual({ 'stellar:*': ['GFACILITATOR'] });
  });

  it('forwards a valid v2 verification request to the engine', async () => {
    const paymentEngine = engine();
    const response = await request(createApp({ config: config(), engine: paymentEngine, log: silentLogger }))
      .post('/verify')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body);
    expect(response.status).toBe(200);
    expect(response.body.isValid).toBe(true);
    expect(paymentEngine.verify).toHaveBeenCalledOnce();
  });

  it('rejects malformed and non-v2 requests before they reach the engine', async () => {
    const paymentEngine = engine();
    const response = await request(createApp({ config: config(), engine: paymentEngine, log: silentLogger }))
      .post('/verify')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ ...body, x402Version: 1 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_REQUEST');
    expect(paymentEngine.verify).not.toHaveBeenCalled();
  });

  it('returns protocol-shaped failures without exposing engine details', async () => {
    const paymentEngine = engine({
      verify: vi.fn(async () => { throw new Error('RPC https://secret.internal account S_NOT_A_KEY'); }),
      settle: vi.fn(async () => { throw new Error('sequence account details'); }),
    });
    const app = createApp({ config: config(), engine: paymentEngine, log: silentLogger });
    const verification = await request(app).post('/verify')
      .set('authorization', `Bearer ${apiKey}`).send(body);
    const settlement = await request(app).post('/settle')
      .set('authorization', `Bearer ${apiKey}`).send(body);
    expect(verification.status).toBe(502);
    expect(verification.body).toEqual({ isValid: false, invalidReason: 'verify_internal_error' });
    expect(settlement.status).toBe(502);
    expect(settlement.body).toMatchObject({
      success: false,
      errorReason: 'settle_internal_error',
      transaction: '',
      network: 'stellar:testnet',
    });
    expect(JSON.stringify([verification.body, settlement.body])).not.toContain('secret.internal');
  });

  it('coalesces concurrent settles and caches successful retries', async () => {
    let release!: (value: SettleResponse) => void;
    const pending = new Promise<SettleResponse>(resolve => { release = resolve; });
    const settle = vi.fn(() => pending);
    const app = createApp({ config: config(), engine: engine({ settle }), log: silentLogger });

    const first = request(app).post('/settle').set('authorization', `Bearer ${apiKey}`).send(body);
    const second = request(app).post('/settle').set('authorization', `Bearer ${apiKey}`).send(body);
    await new Promise(resolve => setImmediate(resolve));
    release({ success: true, transaction: 'same-tx', network: 'stellar:testnet' });
    expect((await first).body.transaction).toBe('same-tx');
    expect((await second).body.transaction).toBe('same-tx');
    expect(settle).toHaveBeenCalledOnce();

    const retry = await request(app).post('/settle')
      .set('authorization', `Bearer ${apiKey}`).send(body);
    expect(retry.body.transaction).toBe('same-tx');
    expect(settle).toHaveBeenCalledOnce();
  });

  it('reports a successful settlement to Bazaar when configured', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = createApp({
      config: config({
        bazaarSettlementUrl: 'http://127.0.0.1:8402/discovery/settlements',
        bazaarSettlementApiKey: 'bazaar-secret',
      }),
      engine: engine(),
      log: silentLogger,
    });
    const requestBody = structuredClone(body);
    requestBody.paymentPayload.resource = { url: 'https://agentsmith.xyz/metar/v1/metar' };

    const response = await request(app).post('/settle')
      .set('authorization', `Bearer ${apiKey}`)
      .send(requestBody);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8402/discovery/settlements');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer bazaar-secret');
    expect(JSON.parse(String(init.body))).toMatchObject({
      transaction: 'abc123',
      resource_url: 'https://agentsmith.xyz/metar/v1/metar',
      network: 'stellar:testnet',
    });
    vi.unstubAllGlobals();
  });

  it('uses a server-to-server bearer token when configured', async () => {
    const app = createApp({
      config: config({ apiKey: 'resource-server-only' }),
      engine: engine(),
      log: silentLogger,
    });
    expect((await request(app).get('/supported')).status).toBe(401);
    expect((await request(app).post('/verify').send(body)).status).toBe(401);
    expect((await request(app).post('/verify')
      .set('authorization', 'Bearer resource-server-only').send(body)).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('defaults missing extra objects before calling the Stellar scheme', async () => {
    const paymentEngine = engine();
    const withoutExtra = structuredClone(body) as typeof body;
    delete (withoutExtra.paymentPayload.accepted as Partial<typeof requirements>).extra;
    delete (withoutExtra.paymentRequirements as Partial<typeof requirements>).extra;

    const response = await request(createApp({ config: config(), engine: paymentEngine, log: silentLogger }))
      .post('/verify')
      .set('authorization', `Bearer ${apiKey}`)
      .send(withoutExtra);

    expect(response.status).toBe(200);
    expect(paymentEngine.verify).toHaveBeenCalledWith(
      expect.objectContaining({ accepted: expect.objectContaining({ extra: {} }) }),
      expect.objectContaining({ extra: {} }),
    );
  });
});
