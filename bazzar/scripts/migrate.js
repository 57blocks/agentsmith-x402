import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, pool } from '../src/db.js';

const schemasDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

if (process.argv.includes('--drop')) {
  console.log('[migrate] dropping resources');
  await query('DROP TABLE IF EXISTS resources CASCADE');
  await query('DROP FUNCTION IF EXISTS resource_search_doc(resources) CASCADE');
}

const files = (await readdir(schemasDir)).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  process.stdout.write(`[migrate] ${f} ... `);
  await query(await readFile(join(schemasDir, f), 'utf8'));
  console.log('ok');
}

const { rows } = await query('SELECT count(*)::int AS n FROM resources');
console.log(`[migrate] done. ${rows[0].n} resources in catalog.`);
await pool.end();
