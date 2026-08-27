import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express, { type ErrorRequestHandler, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { FacilitatorConfig } from './config.js';
import { createStellarPaymentEngine, type PaymentEngine } from './engine.js';
import { logger, type Logger } from './logger.js';
import { SettlementCoordinator, settlementKey } from './settlement-coordinator.js';
import { facilitatorRequestSchema, validationMessage, type FacilitatorRequest } from './validation.js';

export interface AppOptions {
  config: FacilitatorConfig;
  engine?: PaymentEngine;
  log?: Logger;
}

function requireApiKey(expected: string): RequestHandler {
  return (req, res, next) => {
    const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
    const actualHash = createHash('sha256').update(provided).digest();
    const expectedHash = createHash('sha256').update(expected).digest();
    if (!timingSafeEqual(actualHash, expectedHash)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } });
      return;
    }
    next();
  };
}

function parseRequest(body: unknown, res: Response): FacilitatorRequest | undefined {
  const parsed = facilitatorRequestSchema.safeParse(body);
  if (parsed.success) return parsed.data;

  res.status(400).json({
    error: { code: 'INVALID_REQUEST', message: validationMessage(parsed.error) },
  });
  return undefined;
}

export function createApp(options: AppOptions) {
  const config = options.config;
  const log = options.log || logger;
  const engine = options.engine || createStellarPaymentEngine(config, log);
  const settlements = new SettlementCoordinator(
    config.settlementCacheTtlMs,
    config.settlementCacheMaxEntries,
  );
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: config.maxBodySize }));
  app.use((req, res, next) => {
    const requestId = req.get('x-request-id') || randomUUID();
    res.setHeader('x-request-id', requestId);
    const startedAt = Date.now();
    res.on('finish', () => log.info('http_request', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
    next();
  });

  const limiter = rateLimit({
    windowMs: config.rateLimitWindowMs,
    limit: config.rateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
  });
  const auth = requireApiKey(config.apiKey);

  app.get('/health', (_req, res) => res.json({
    ok: true,
    service: 'agentsmith-stellar-facilitator',
    version: '0.1.0',
    network: config.network,
    mode: config.channelSecrets.length > 0 ? 'fee-bump-channels' : 'single-signer',
  }));

  app.get('/supported', limiter, auth, (_req, res) => res.json(engine.supported()));

  app.post('/verify', limiter, auth, async (req, res) => {
    const request = parseRequest(req.body, res);
    if (!request) return;
    try {
      const response = await engine.verify(
        request.paymentPayload as PaymentPayload,
        request.paymentRequirements as PaymentRequirements,
      );
      res.json(response);
    } catch (error) {
      log.error('verify_unhandled_error', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      res.status(502).json({ isValid: false, invalidReason: 'verify_internal_error' });
    }
  });

  app.post('/settle', limiter, auth, async (req, res) => {
    const request = parseRequest(req.body, res);
    if (!request) return;
    const { paymentPayload, paymentRequirements } = request;
    try {
      const response = await settlements.run(
        settlementKey({ paymentPayload, paymentRequirements }),
        () => engine.settle(
          paymentPayload as PaymentPayload,
          paymentRequirements as PaymentRequirements,
        ),
      );
      res.json(response);
    } catch (error) {
      log.error('settle_unhandled_error', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      res.status(502).json({
        success: false,
        errorReason: 'settle_internal_error',
        payer: undefined,
        transaction: '',
        network: paymentRequirements.network as `${string}:${string}`,
      } satisfies SettleResponse);
    }
  });

  app.use((_req, res) => res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  }));

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const tooLarge = error instanceof Error && 'type' in error && error.type === 'entity.too.large';
    log.error('http_unhandled_error', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    res.status(tooLarge ? 413 : 500).json({
      error: {
        code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR',
        message: tooLarge ? 'Request body is too large' : 'Internal server error',
      },
    });
  };
  app.use(errors);
  return app;
}
