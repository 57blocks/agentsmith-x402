import { ValidationError } from './ingest.js';

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { reject(new ValidationError('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new ValidationError('body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}
