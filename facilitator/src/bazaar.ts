import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import type { FacilitatorConfig } from './config.js';
import type { Logger } from './logger.js';

type ResourceValue = string | { url?: string } | undefined;

function resourceUrl(payload: PaymentPayload, requirements: PaymentRequirements): string | undefined {
  const payloadResource = (payload as unknown as { resource?: ResourceValue }).resource;
  const requirementResource = (requirements as unknown as { resource?: ResourceValue }).resource;
  const value = payloadResource ?? requirementResource;
  return typeof value === 'string' ? value : value?.url;
}

/** Report a successful on-chain payment without making settlement dependent on
 * the discovery service. Reporting failures are logged and intentionally
 * swallowed: the facilitator has already settled the payment. */
export async function reportSettlement(
  config: FacilitatorConfig,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  response: SettleResponse,
  log: Logger,
): Promise<void> {
  if (!config.bazaarSettlementUrl || !response.success || !response.transaction) return;

  const url = resourceUrl(payload, requirements);
  if (!url) {
    log.warn('settlement_report_skipped', { reason: 'resource_url_missing', transaction: response.transaction });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.bazaarSettlementApiKey) {
      headers.authorization = `Bearer ${config.bazaarSettlementApiKey}`;
    }
    const reported = await fetch(config.bazaarSettlementUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        transaction: response.transaction,
        resource_url: url,
        network: response.network || requirements.network,
        payer: response.payer,
      }),
      signal: controller.signal,
    });
    if (!reported.ok) {
      log.warn('settlement_report_failed', {
        status: reported.status,
        transaction: response.transaction,
      });
      return;
    }
    log.info('settlement_reported', { transaction: response.transaction, resource_url: url });
  } catch (error) {
    log.warn('settlement_report_failed', {
      transaction: response.transaction,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  } finally {
    clearTimeout(timer);
  }
}
