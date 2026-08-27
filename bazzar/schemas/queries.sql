-- Catalog inspection cheat sheet.  Run one with:
--   npm run db -- -c "<query>"
-- or open a session with:  npm run db

-- everything in the catalog, most recent first
SELECT service_name, type, tool_name, price_usd, asset, network, payable
FROM resources ORDER BY created_at DESC;

-- one listing in full, including the raw submission we never modify
SELECT id, service_name, raw_metadata, normalized_metadata, enrichment_metadata
FROM resources WHERE id = 'http_wDM-KOFrNEEU42Ow';

-- what the lexical branch actually indexed, by weight band
SELECT service_name, search_title, search_body, search_params FROM resources;

-- the tsvector itself: which lemmas are searchable and in which band
SELECT service_name, search_doc FROM resources WHERE service_name ILIKE '%weather%';

-- score a query by hand, exactly as the lexical branch does
SELECT service_name,
       ts_rank_cd(search_doc, to_tsquery('english', 'weather | forecast | daily')) AS score
FROM resources
WHERE search_doc @@ to_tsquery('english', 'weather | forecast | daily')
ORDER BY score DESC;

-- required input parameters per listing
SELECT service_name, p->>'name' AS param, p->>'description' AS description
FROM resources, jsonb_array_elements(input_params) p
WHERE (p->>'required')::boolean ORDER BY service_name;

-- anything unpayable, and why it is withheld from ranking
SELECT service_name, asset, payable_reason FROM resources WHERE NOT payable;

-- providers and how many listings each has
SELECT pay_to, count(*), array_agg(DISTINCT service_name)
FROM resources GROUP BY pay_to ORDER BY count DESC;
