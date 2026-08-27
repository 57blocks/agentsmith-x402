/** Map a catalog row to the compact shape the search_services tool returns.
 *  `available` is passed by the caller (retrieve() rows are payable; withheld
 *  rows are not) so presence of a payTo is never mistaken for availability. */
export function presentResult(row, available) {
  const out = {
    resource_id: row.id,
    name: row.service_name,
    description: row.description,
    type: row.type,
    url: row.resource_url,
    network: row.network,
    asset: row.asset,
    price_usd: Number(row.price_usd),
    tags: row.tags || [],
    match_score: row.match !== undefined ? Number(Number(row.match).toFixed(2)) : undefined,
    available
  };
  if (row.tool_name) out.toolName = row.tool_name;
  if (!available) out.reason = row.payable_reason || 'unavailable';
  return out;
}
