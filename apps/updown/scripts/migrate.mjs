// Apply db/*.sql (the updown_rounds journal tables) to DATABASE_URL_UNPOOLED, else DATABASE_URL.
// Usage (from apps/updown): npm run migrate
// The URLs come from the environment, else from this app's gitignored .env.
// It is a server-only value: never a VITE_* variable, never printed.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { migrate } from '../server/migrate.mjs';
import { migrationDatabaseUrl, pgSsl } from '../server/pg-ssl.mjs';

// DATABASE_URL_UNPOOLED (Vercel's Neon integration: the direct, non-PgBouncer URL)
// is preferred for migrations; DATABASE_URL otherwise.
if (existsSync('.env')) {
  const local = parseEnv(readFileSync('.env', 'utf8'));
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) if (!process.env[name] && local[name]) process.env[name] = local[name];
}
const databaseUrl = migrationDatabaseUrl();
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Nothing to migrate.');
  process.exit(1);
}

const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: pgSsl(databaseUrl) });
try {
  const { applied } = await migrate({ connect: () => pool.connect() });
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'No pending migrations.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
