-- Bazaar catalog schema.
--
-- Three representations are kept per the retrieval design: the raw listing is
-- never modified and is the source of truth, normalized_metadata is
-- deterministic reshaping, enrichment_metadata is model-derived and optional.
-- The remaining columns are the retrieval view -- the only fields search reads.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS resources (
  id                  TEXT PRIMARY KEY,

  -- three representations
  raw_metadata        JSONB       NOT NULL,
  normalized_metadata JSONB       NOT NULL DEFAULT '{}'::jsonb,
  enrichment_metadata JSONB,
  enrichment_version  TEXT,

  -- retrieval view: text signal
  service_name        TEXT        NOT NULL,
  description         TEXT        NOT NULL DEFAULT '',
  tags                TEXT[]      NOT NULL DEFAULT '{}',
  input_params        JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{name, description, required}]
  output_params       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  output_structure    TEXT,

  -- Weighted search bands, projected at ingest. Generated columns cannot
  -- contain subqueries, so the jsonb parameter arrays are flattened to text
  -- during projection rather than at query time.
  search_title        TEXT        NOT NULL DEFAULT '',  -- name + tags
  search_body         TEXT        NOT NULL DEFAULT '',  -- description + output shape + enrichment
  search_params       TEXT        NOT NULL DEFAULT '',  -- parameter names + descriptions

  -- retrieval view: structured constraints
  type                TEXT        NOT NULL CHECK (type IN ('http','mcp')),
  transport           TEXT,
  network             TEXT        NOT NULL,
  asset               TEXT        NOT NULL,
  scheme              TEXT        NOT NULL DEFAULT 'exact' CHECK (scheme IN ('exact','upto')),
  amount_atomic       NUMERIC(78,0) NOT NULL,
  price_usd           NUMERIC(12,6) NOT NULL,

  -- rejoined after ranking, never sent to the ranking layer
  resource_url        TEXT        NOT NULL,
  tool_name           TEXT,
  pay_to              TEXT        NOT NULL,

  -- settleability. unpayable resources are filtered before ranking
  payable             BOOLEAN     NOT NULL DEFAULT TRUE,
  payable_reason      TEXT,

  -- facts about the listing. never inputs to the ranking score
  settlements         INTEGER     NOT NULL DEFAULT 0,
  last_settled_at     TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Lexical branch. Weighted so the service name and tags outrank body text,
  -- and parameter descriptions still contribute -- how a service is called is
  -- part of what it means, and is often all that separates near-identical
  -- services.
  search_doc TSVECTOR GENERATED ALWAYS AS (
       setweight(to_tsvector('english', search_title),  'A')
    || setweight(to_tsvector('english', search_body),   'B')
    || setweight(to_tsvector('english', search_params), 'C')
  ) STORED
);

-- Keep upgrades from an earlier catalog schema deployable. Existing rows are
-- left nullable until their provider re-registers with a v2 atomic amount.
ALTER TABLE resources ADD COLUMN IF NOT EXISTS amount_atomic NUMERIC(78,0);

-- MCP tools are keyed on (resource.url, input.toolName) per the Bazaar spec,
-- since one MCP endpoint multiplexes many tools.
CREATE UNIQUE INDEX IF NOT EXISTS resources_identity
  ON resources (resource_url, COALESCE(tool_name, ''));

CREATE INDEX IF NOT EXISTS resources_search_doc_idx ON resources USING GIN (search_doc);

-- Fuzzy branch. Catches vocabulary the lexical branch tokenizes differently.
CREATE INDEX IF NOT EXISTS resources_trgm_idx
  ON resources USING GIN ((search_title || ' ' || search_body) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS resources_network_idx ON resources (network);
CREATE INDEX IF NOT EXISTS resources_asset_idx   ON resources (asset);
CREATE INDEX IF NOT EXISTS resources_type_idx    ON resources (type);
CREATE INDEX IF NOT EXISTS resources_price_idx   ON resources (price_usd);

-- One row per successful on-chain settlement. The transaction hash is the
-- idempotency key: retries from a resource server or facilitator must not
-- inflate the catalog's usage facts.
CREATE TABLE IF NOT EXISTS settlement_events (
  transaction_hash TEXT PRIMARY KEY,
  resource_url     TEXT NOT NULL,
  network          TEXT NOT NULL,
  payer            TEXT,
  settled_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS settlement_events_resource_idx
  ON settlement_events (resource_url, settled_at DESC);
