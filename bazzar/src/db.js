import 'dotenv/config';
import pg from 'pg';

// Postgres returns NUMERIC as a string to avoid float precision loss. Prices
// here are small and bounded, so parse them for JSON output
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://localhost:5432/bazaar',
  max: 10
});

export const query = (text, params) => pool.query(text, params);

export async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
