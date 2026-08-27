# Bazaar and Facilitator repository move

This branch is based on the original `main`. It contains the review cleanup only; it does not
include the larger Bazaar/facilitator rewrite that was checkpointed on
`codex/today-bazaar-facilitator`.

## What to copy

The two services contain **42 tracked files** in total:

| Service | Files | Required contents |
| --- | ---: | --- |
| `bazzar/` | 22 | `package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `README.md`; `schemas/`; `scripts/`; `src/`; `test/` |
| `facilitator/` | 20 | `package.json`, `package-lock.json`, `.env.example`, `.dockerignore`, `Dockerfile`, `docker-compose.yml`, `README.md`; `scripts/`; `src/`; `tests/`; `tsconfig.json`; `vitest.config.ts` |

Copy the root [`LICENSE`](/Users/57block/Project/agentsmith/LICENSE) as well. It is Apache-2.0
and should remain at the new repository root.

For a cloud deployment, also copy and adapt:

- `.github/workflows/deploy.yml` (only the Bazaar and Facilitator jobs, or a new workflow in the
  destination repository)
- `deploy/nginx/agentsmith.conf.template` and
  `deploy/nginx/agentsmith-http-only.conf.template` (the `/facilitator/` proxy is loopback-only)
- the relevant sections of `DEPLOYMENT.md`

If the new repository also owns the Weather listing, copy `weather-metar/` separately. Bazaar
does not contain provider credentials or Weather implementation code; it only stores the listing
posted by the Weather registration script.

## Do not copy

Do not move `.env`, private keys, API keys, `node_modules/`, `dist/`, local Postgres data, test
outputs, or runtime artifacts such as `.mineru.json`, `.data/`, and `output/`. Generate a fresh
`.env` on the target host from each `.env.example` and provision secrets through the host secret
manager.

## Configuration that must be recreated

### Bazaar

- `DATABASE_URL`: PostgreSQL connection string for the target catalog database.
- `PORT`: REST port (8402 by default).
- `MCP_PORT`: MCP Streamable HTTP port (8406 by default).
- `BASE_URL`: public origin used when advertising the MCP URL.

Run `npm ci`, then `npm run migrate` before starting the service. Register each resource server
against the new Bazaar URL after it is healthy.

### Facilitator

- `STELLAR_NETWORK`: one process per network (`stellar:testnet` or `stellar:pubnet`).
- `STELLAR_RPC_URL`: Soroban RPC endpoint.
- `FACILITATOR_STELLAR_PRIVATE_KEY`, or the fee-bump/channel pair for high-throughput mode.
- `FACILITATOR_API_KEY`: required server-to-server Bearer token.
- `HOST=127.0.0.1` when Nginx is the only caller; publish no direct Facilitator port.

The resource servers must receive the same key as `X402_FACILITATOR_API_KEY`. Never put any of
these secrets in the Bazaar catalog, browser code, paid API responses, or MCP results.

Build with `npm ci --include=dev && npm run build`, then run `npm start` (or the supplied Docker
Compose service). Verify `/health` and authenticated `/supported` before registering providers.

## File inventory

The exact tracked inventory can be reproduced from the source checkout with:

```bash
git ls-files bazzar facilitator
```

The command intentionally excludes ignored dependencies and local secrets, so it is safe to use
as the copy checklist for the destination repository.

Both service manifests currently set `private: true`. Keep that setting for a deployment-only
repository; remove it and add package publishing metadata only if the destination is intended to
publish either service to npm.
