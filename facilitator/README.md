# AgentSmith Stellar Facilitator

A self-hosted x402 v2 Facilitator for fee-sponsored Stellar `exact` payments. Its HTTP surface follows the Coinbase/x402 architecture: `GET /supported`, `POST /verify`, and `POST /settle`. Stellar authorization validation and settlement are delegated to the Apache-2.0 `@x402/stellar` implementation instead of reimplementing security-sensitive XDR and Soroban auth logic.

Requires Node.js 22 or newer.

## Payment path

```text
Buyer -> Resource server: request
Buyer <- Resource server: 402 + PAYMENT-REQUIRED
Buyer -> Resource server: retry + PAYMENT-SIGNATURE
Resource server -> Facilitator: POST /verify
Resource server: invoke the HTTP endpoint or MCP tool
Resource server -> Facilitator: POST /settle
Facilitator -> Stellar RPC: simulate, sign fee-sponsored tx, submit, confirm
Buyer <- Resource server: result + PAYMENT-RESPONSE settlement hash
```

The buyer signs a Soroban authorization entry for one SEP-41 `transfer(from, to, amount)` call. The Facilitator sources the transaction and pays the XLM network fee, but it cannot change the asset, recipient, or amount without invalidating the buyer's authorization. It is not a custodian and is never the source of payment funds.

## Testnet quick start

```bash
npm ci
npm run testnet:create-account
cp .env.example .env
# Put the generated TESTNET secret into .env and generate FACILITATOR_API_KEY, then:
npm test
npm run dev
```

Check the local authenticated interface:

```bash
curl http://localhost:8407/health
curl -H "Authorization: Bearer $FACILITATOR_API_KEY" http://localhost:8407/supported
```

`/supported` must advertise `x402Version: 2`, `scheme: exact`, `network: stellar:testnet`, and `extra.areFeesSponsored: true`. Point a resource server at `http://localhost:8407`; it is the resource server—not the buyer/browser—that calls `/verify` and `/settle`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FACILITATOR_STELLAR_PRIVATE_KEY` | required in single-signer mode | Transaction source and fee payer secret |
| `STELLAR_NETWORK` | `stellar:testnet` | One process serves `stellar:testnet` or `stellar:pubnet` |
| `STELLAR_RPC_URL` | SDF testnet RPC | Soroban JSON-RPC endpoint |
| `FACILITATOR_API_KEY` | required | Resource-server-to-Facilitator Bearer token on testnet and pubnet |
| `MAX_TRANSACTION_FEE_STROOPS` | `50000` | Hard cap on sponsored fees; matches the SDK default and may be raised deliberately after testnet measurement |
| `FACILITATOR_STELLAR_FEE_BUMP_SECRET` | unset | Separate high-throughput fee payer |
| `FACILITATOR_STELLAR_CHANNEL_SECRETS` | unset | Comma-separated channel-account secrets |

Every network refuses to start without `FACILITATOR_API_KEY`. Keep port 8407 private: buyers call the
paid Resource Server, while only that server calls the Facilitator. The supplied Docker Compose
file binds it to loopback; when using Nginx, apply the equivalent private upstream rule. Run
separate testnet and pubnet instances because each scheme adapter is bound to one RPC/network
pair. Do not expose port 8407 directly to buyers or the public internet.

## Credential rules

- Stellar secret keys, channel secrets, the fee-bump secret, and `FACILITATOR_API_KEY` are server-side only. Store them in a secret manager or an untracked `.env` file.
- `/supported` returns only public signer addresses. `/verify` may return the public payer address. `/settle` returns the public payer and transaction hash.
- Never return an API key/token/secret after a paid API or MCP call. The paid response is the requested resource plus the `PAYMENT-RESPONSE` settlement receipt. Upstream provider credentials remain inside the resource server.
- Logs intentionally exclude authorization headers, payment payloads, signatures, and private keys.

## Idempotency and scaling

The process coalesces concurrent identical `/settle` calls and caches successful results for five minutes. That TTL is independent of `maxTimeoutSeconds`: after the cache entry expires, retrying the same signed authorization reaches Stellar again. On-chain replay protection prevents a second transfer, but the caller receives a failed settlement instead of the original success receipt. The in-memory cache is a single-process optimization; a multi-replica production deployment should replace it with a durable Redis/PostgreSQL settlement journal keyed by the canonical request hash and retained for at least the accepted authorization lifetime.
