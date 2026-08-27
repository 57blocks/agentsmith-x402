# agentsmith-x402

Open-source x402 payments and discovery for Stellar. Agents discover HTTP and MCP services in
Bazaar, receive a 402 payment challenge from the resource server, and pay through a self-hosted
Stellar Facilitator.

## Components

- [`bazzar/`](bazzar/README.md) — PostgreSQL-backed discovery API and MCP search service.
- [`facilitator/`](facilitator/README.md) — authenticated Stellar `exact` payment verification
  and settlement service using `@x402/stellar`.

The two services are independent processes. Bazaar never holds payment credentials, and the
Facilitator never handles provider credentials or invokes the paid resource.

## Local quick start

Start PostgreSQL and create a database named `bazaar`, then run Bazaar:

```bash
cd bazzar
npm ci
cp .env.example .env
npm run migrate
npm start
```

In a second terminal, configure the testnet Facilitator:

```bash
cd facilitator
npm ci
cp .env.example .env
# Set FACILITATOR_STELLAR_PRIVATE_KEY and FACILITATOR_API_KEY in .env.
npm run typecheck
npm run dev
```

Bazaar REST runs on `http://127.0.0.1:8402`; its MCP endpoint runs on port `8406`. The
Facilitator listens on `127.0.0.1:8407` by default. Check `/health` and authenticated
`/supported` before registering resource listings.

## Deployment

Use the service-specific Docker Compose file or adapt the workflow and Nginx templates from the
original agentsmith repository. Keep Facilitator port 8407 private to resource servers and put
all secrets in the host secret manager or an untracked `.env` file.

See the [migration checklist](docs/repo-migration-bazaar-facilitator.md) for the complete file
inventory and required configuration.

## License

Apache-2.0. See [LICENSE](LICENSE).
