import { x402Facilitator } from '@x402/core/facilitator';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { createEd25519Signer } from '@x402/stellar';
import { ExactStellarScheme } from '@x402/stellar/exact/facilitator';
import type { FacilitatorConfig } from './config.js';
import type { Logger } from './logger.js';

export interface PaymentEngine {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  supported(): ReturnType<x402Facilitator['getSupported']>;
}

export function createStellarPaymentEngine(
  config: FacilitatorConfig,
  log: Logger,
): PaymentEngine {
  const rpcConfig = { url: config.rpcUrl };
  const schemeOptions = {
    rpcConfig,
    maxTransactionFeeStroops: config.maxTransactionFeeStroops,
  };

  let scheme: ExactStellarScheme;
  if (config.feeBumpSecret && config.channelSecrets.length > 0) {
    const channelSigners = config.channelSecrets.map(secret => createEd25519Signer(secret));
    const feeBumpSigner = createEd25519Signer(config.feeBumpSecret);
    scheme = new ExactStellarScheme(channelSigners, { ...schemeOptions, feeBumpSigner });
    log.info('facilitator_engine_ready', {
      network: config.network,
      mode: 'fee-bump-channels',
      feeBumpAddress: feeBumpSigner.address,
      signerAddresses: channelSigners.map(signer => signer.address),
    });
  } else {
    if (!config.privateKey) {
      throw new Error('single-signer mode requires FACILITATOR_STELLAR_PRIVATE_KEY');
    }
    const signer = createEd25519Signer(config.privateKey);
    scheme = new ExactStellarScheme([signer], schemeOptions);
    log.info('facilitator_engine_ready', {
      network: config.network,
      mode: 'single-signer',
      signerAddresses: [signer.address],
    });
  }

  const facilitator = new x402Facilitator()
    .onAfterVerify(async ({ requirements, result }) => {
      log.info('payment_verified', {
        network: requirements.network,
        scheme: requirements.scheme,
        valid: result.isValid,
        payer: result.payer,
      });
    })
    .onVerifyFailure(async ({ requirements, error }) => {
      log.warn('payment_verify_failed', {
        network: requirements.network,
        scheme: requirements.scheme,
        errorName: error.name,
      });
    })
    .onAfterSettle(async ({ requirements, result }) => {
      log.info('payment_settled', {
        network: requirements.network,
        scheme: requirements.scheme,
        success: result.success,
        payer: result.payer,
        transaction: result.transaction,
      });
    })
    .onSettleFailure(async ({ requirements, error }) => {
      log.warn('payment_settle_failed', {
        network: requirements.network,
        scheme: requirements.scheme,
        errorName: error.name,
      });
    });

  facilitator.register(config.network, scheme);
  return {
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
    supported: () => facilitator.getSupported(),
  };
}
