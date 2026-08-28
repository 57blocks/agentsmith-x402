# Bazaar — discovery service

Query understanding, structured filtering and lexical candidate retrieval over PostgreSQL.
Plain Node (`node:http`) with PostgreSQL and MCP runtime dependencies.

This is the deterministic lexical implementation: raw listing, normalization, structured
filters, and keyword retrieval, **with no model dependency**. Dense retrieval is a planned
extension, not required to run this service.

Requires Node.js 20 or newer.

## Run

```bash
brew services start postgresql@16
createdb bazaar

npm ci
npm run migrate     # applies schemas/*.sql
npm start           # http://localhost:8402
```

The catalog starts empty. There is no seed data: a listing exists only after a resource server
registers it. Provider projects can live in another repository; point their registration command
at this Bazaar instance after the service is healthy.

`npm run reset` drops and rebuilds. `DATABASE_URL`, `PORT`, and `MCP_PORT` override the defaults.
Set `BAZAAR_SETTLEMENT_API_KEY` to enable the authenticated settlement callback used by the
Facilitator.

## Inspecting the catalog

On macOS, `npm run db` wraps the Homebrew PostgreSQL client:

```bash
npm run db                                    # interactive session
npm run db -- -c "SELECT service_name, type, price_usd FROM resources;"
npm run db -- -f schemas/queries.sql          # run the whole cheat sheet
```

On Linux or another PostgreSQL installation, use `psql` directly:

```bash
psql "$DATABASE_URL" -f schemas/queries.sql
```

`schemas/queries.sql` holds the queries worth knowing — what was indexed in
each weight band, the raw submission as received, required parameters per
listing, anything withheld as unpayable, and how to score a query by hand
exactly as the lexical branch does. Useful psql meta-commands: `\dt` tables,
`\d resources` columns, `\x` toggle expanded output for wide `jsonb` rows.

## Endpoints

| | |
|---|---|
| `GET /health` | liveness + catalog size |
| `GET /discovery/search?query=…` | natural language, ranked; query may be omitted to browse |
| `GET /discovery/resources?…` | browse, offset pagination |
| `GET /discovery/resources/:id` | full listing including raw metadata |
| `POST /discovery/register` | catalog a listing |
| `POST /discovery/settlements` | record a successful settlement (server-to-server) |

`/discovery/settlements` requires `Authorization: Bearer $BAZAAR_SETTLEMENT_API_KEY`.
The Facilitator posts the transaction hash, resource URL, network, and payer after settlement.
Transaction hashes are idempotent, so retries do not inflate the listing's settlement count.

Search accepts `type`, `network`, `asset`, `scheme`, `maxPriceUsd`, `limit`. Filters passed
explicitly on the URL are treated as caller-asserted and override anything parsed from the
query text at full confidence.

```bash
curl --get http://localhost:8402/discovery/search \
  --data-urlencode "query=turn scanned documents into structured data, USDC, under five cents"
```

## MCP interface

The same discovery is also served as an MCP tool over Streamable HTTP, on its **own port**
(not the REST port): `POST/GET/DELETE http://localhost:8406/mcp` (default; set `MCP_PORT` to
change). Stateless, unauthenticated, free — same posture as `/discovery/search`.

One tool, `search_services`: `query` (required) plus optional `type` (`http`|`mcp`),
`network`, `asset`, `maxPriceUsd`, `limit` (default 20). Returns `structuredContent` with
`results[]` (`resource_id`, `name`, `description`, `type`, `url`, `toolName?`, `network`,
`asset`, `price_usd`, `tags`, `match_score`, `available`, `reason?`), `matched`,
`total_available`, `unavailable`, `took_ms`, plus a text summary. Available (payable)
services rank first; unavailable ones are appended at the tail, each carrying a `reason`.

```bash
curl -s -X POST http://localhost:8406/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Responses are SSE-framed; the intended way to call this is a proper MCP client
(`@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`), not raw `curl`.

## What the response carries

**The parse comes back.** A caller never has to guess how its request was read:

```json
"parse": {
  "capability": "turn scanned documents into structured data",
  "constraints": [
    { "name": "asset",       "value": "USDC", "confidence": 0.98, "applied": "filter", "source": "USDC" },
    { "name": "maxPriceUsd", "value": 0.05,   "confidence": 0.88, "applied": "filter", "source": "under five cents" }
  ],
  "hard_threshold": 0.8
}
```

Constraints at or above the threshold become SQL predicates and run **before** ranking, so a
result the caller cannot pay for never occupies a ranked slot. Below it they stay soft and only
shade the order — a misread narrows results rather than deleting the right answer. Each demoted
result says why, under `soft_penalties`.

**Callability is information, not a filter.** Each result reports
`unfilled_required_parameters`. Whether the agent can actually supply them depends on tools and
context the catalog does not have — an agent holding a geocoder fills `latitude`/`longitude`
trivially — so this carries a small bounded weight and never removes a candidate.

**Unpayable resources are withheld, not warned about.** A listing whose seller cannot receive
the asset it prices in is filtered before ranking and reported separately under `withheld`,
with the reason.

**Facts are not ranking inputs.** `facts.settlements` and `facts.last_settled_at` are returned
because they are useful, and are never terms in the score. Credibility is Phase 2 and is
designed to re-rank only within a relevance band.

**Every response records its own retrieval configuration and timing**, so a result can be
reproduced or contradicted.

## Retrieval

The current implementation uses a small PostgreSQL-backed lexical ranker. It tokenizes the
capability, removes stop words, and matches the remaining terms at word boundaries across the
service name, tags, description, and parameter descriptions. Names and tags carry the most
weight; descriptions carry more than parameter text. A term that appears in most listings can
contribute to a score but cannot select a result on its own.

The query is intentionally a selective disjunction rather than an `AND`: agents tend to submit
whole task descriptions, while no single listing contains every word. Input is reduced to
alphanumerics and escaped before it reaches PostgreSQL's regular-expression engine.

Dense retrieval, fuzzy matching, and model-assisted enrichment are planned extensions, not part
of this build.

## Storage

`schemas/001_resources.sql`. Three representations per the design:

| | |
|---|---|
| `raw_metadata` | exactly as submitted, never modified, source of truth |
| `normalized_metadata` | deterministic reshaping — canonical network id, uppercase asset, comparable price |
| `enrichment_metadata` | model-derived, `NULL` in this build since no model is configured |

Everything else is the **retrieval view** — the fields used by search ranking. Payment identity
and resource URL are carried through the query so the response can be assembled after ranking;
the raw submission remains available only from the detail endpoint.

`schemas/listing.schema.json` is the submission contract, following the x402 bazaar extension.

## Registering a service

```bash
curl -X POST http://localhost:8402/discovery/register \
  -H 'content-type: application/json' \
  -d '{ "resource": {...}, "info": {...}, "accepts": [...] }'
```

Returns a `bazaar.status` outcome with the assigned `resource_id`. MCP tools are keyed on
`(resource.url, input.toolName)` because one MCP endpoint may multiplex many tools.

The registration endpoint is unauthenticated in this build. Keep it on a private network or put
it behind an API gateway before exposing the Bazaar service publicly.

Listings project the first `accepts[]` entry. The v2 `amount` field is stored as an atomic-unit
integer. For known 7-decimal Stellar USDC contracts, the catalog also derives the display price.
Legacy `maxAmountRequired` remains accepted: integer strings are treated as atomic units, while
decimal strings are converted only when the asset's decimal precision is known.

Re-registering the same resource URL updates its payment terms, including network, asset,
scheme, recipient, and amount. Run `npm run migrate` before deploying this version so existing
databases receive the `amount_atomic` and settlement-journal columns.

## Not in this build

Dense retrieval, cross-encoder reranking, model-assisted enrichment, credibility scoring,
multilingual retrieval, and ANN indexing are intentionally out of scope for this build.
