import { pgSsl } from './pg-ssl.mjs';

/**
 * pg.Pool for a Postgres URL, for the local worker and `npm run migrate` (the
 * website creates its own pool). TLS per pg-ssl.mjs.
 */
export async function createPostgresPool(databaseUrl, options = {}) {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: databaseUrl, ssl: pgSsl(databaseUrl), ...options });
}
