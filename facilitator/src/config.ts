const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';

export type StellarNetwork = 'stellar:testnet' | 'stellar:pubnet';

export interface FacilitatorConfig {
  port: number;
  host: string;
  nodeEnv: string;
  network: StellarNetwork;
  rpcUrl: string;
  privateKey?: string;
  feeBumpSecret?: string;
  channelSecrets: string[];
  apiKey: string;
  maxTransactionFeeStroops: number;
  maxBodySize: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  settlementCacheTtlMs: number;
  settlementCacheMaxEntries: number;
  trustProxy: string[];
  corsOrigins: '*' | string[];
  shutdownTimeoutMs: number;
}

function list(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function url(name: string, raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error(`${name} must use HTTPS unless it points to localhost`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const network = (env.STELLAR_NETWORK || 'stellar:testnet') as StellarNetwork;
  if (network !== 'stellar:testnet' && network !== 'stellar:pubnet') {
    throw new Error('STELLAR_NETWORK must be stellar:testnet or stellar:pubnet');
  }

  const port = positiveInteger('PORT', env.PORT, 8407);
  if (port > 65535) throw new Error('PORT must be at most 65535');

  const privateKey = env.FACILITATOR_STELLAR_PRIVATE_KEY?.trim() || undefined;
  const feeBumpSecret = env.FACILITATOR_STELLAR_FEE_BUMP_SECRET?.trim() || undefined;
  const channelSecrets = list(env.FACILITATOR_STELLAR_CHANNEL_SECRETS);
  const highThroughputConfigured = Boolean(feeBumpSecret || channelSecrets.length);
  if (highThroughputConfigured && (!feeBumpSecret || channelSecrets.length === 0)) {
    throw new Error(
      'FACILITATOR_STELLAR_FEE_BUMP_SECRET and FACILITATOR_STELLAR_CHANNEL_SECRETS must be set together',
    );
  }
  if (!highThroughputConfigured && !privateKey) {
    throw new Error(
      'FACILITATOR_STELLAR_PRIVATE_KEY is required unless fee-bump and channel accounts are configured',
    );
  }

  const apiKey = env.FACILITATOR_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('FACILITATOR_API_KEY is required on every network');
  }
  if (network === 'stellar:pubnet' && !env.STELLAR_RPC_URL?.trim()) {
    throw new Error('STELLAR_RPC_URL is required on pubnet');
  }

  const cors = env.CORS_ORIGINS?.trim() || '*';
  return {
    port,
    host: env.HOST?.trim() || '127.0.0.1',
    nodeEnv: env.NODE_ENV || 'development',
    network,
    rpcUrl: url(
      'STELLAR_RPC_URL',
      env.STELLAR_RPC_URL?.trim() || TESTNET_RPC_URL,
    ),
    privateKey,
    feeBumpSecret,
    channelSecrets,
    apiKey,
    maxTransactionFeeStroops: positiveInteger(
      'MAX_TRANSACTION_FEE_STROOPS',
      env.MAX_TRANSACTION_FEE_STROOPS,
      50_000,
    ),
    maxBodySize: env.MAX_BODY_SIZE?.trim() || '256kb',
    rateLimitWindowMs: positiveInteger('RATE_LIMIT_WINDOW_MS', env.RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: positiveInteger('RATE_LIMIT_MAX', env.RATE_LIMIT_MAX, 120),
    settlementCacheTtlMs: positiveInteger(
      'SETTLEMENT_CACHE_TTL_MS',
      env.SETTLEMENT_CACHE_TTL_MS,
      300_000,
    ),
    settlementCacheMaxEntries: positiveInteger(
      'SETTLEMENT_CACHE_MAX_ENTRIES',
      env.SETTLEMENT_CACHE_MAX_ENTRIES,
      10_000,
    ),
    trustProxy: list(env.TRUST_PROXY || 'loopback,linklocal,uniquelocal'),
    corsOrigins: cors === '*' ? '*' : list(cors),
    shutdownTimeoutMs: positiveInteger(
      'SHUTDOWN_TIMEOUT_MS',
      env.SHUTDOWN_TIMEOUT_MS,
      10_000,
    ),
  };
}
