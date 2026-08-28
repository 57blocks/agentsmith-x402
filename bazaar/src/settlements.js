import { withClient } from './db.js';

/**
 * Record a successful settlement and update the matching listing's usage
 * facts. The transaction hash is unique, so retries are safe and do not
 * double-count a payment.
 */
export async function recordSettlement({ transactionHash, resourceUrl, network, payer = null }) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const existing = await client.query(
        'SELECT resource_url, network FROM settlement_events WHERE transaction_hash = $1',
        [transactionHash],
      );
      if (existing.rowCount && (existing.rows[0].resource_url !== resourceUrl || existing.rows[0].network !== network)) {
        await client.query('ROLLBACK');
        return { found: false, recorded: false, conflict: true };
      }

      const resource = await client.query(
        'SELECT id, settlements, last_settled_at FROM resources WHERE resource_url = $1 AND network = $2 LIMIT 1 FOR UPDATE',
        [resourceUrl, network],
      );
      if (!resource.rowCount) {
        await client.query('ROLLBACK');
        return { found: false, recorded: false };
      }

      const inserted = await client.query(
        `INSERT INTO settlement_events (transaction_hash, resource_url, network, payer)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (transaction_hash) DO NOTHING
         RETURNING transaction_hash`,
        [transactionHash, resourceUrl, network, payer],
      );

      if (!inserted.rowCount) {
        await client.query('COMMIT');
        return { found: true, recorded: false, ...resource.rows[0] };
      }

      const updated = await client.query(
        `UPDATE resources
         SET settlements = settlements + 1,
             last_settled_at = now(),
             updated_at = now()
         WHERE id = $1
         RETURNING id, settlements, last_settled_at`,
        [resource.rows[0].id],
      );
      await client.query('COMMIT');
      return { found: true, recorded: true, ...updated.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
