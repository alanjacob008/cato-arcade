/**
 * TLS settings for a Postgres URL, shared by the local worker, `npm run migrate`
 * and the website. Loopback hosts get no TLS. An `sslmode` in the URL (Neon's
 * URLs carry `sslmode=require`) is left to pg, which treats require as
 * verify-full: encrypted and certificate-verified. Any other remote host is
 * verified too unless PGSSL_NO_VERIFY=1 (for providers with self-signed
 * certificates, e.g. Heroku Postgres).
 */
export function pgSsl(databaseUrl, env = process.env) {
  let url;
  try { url = new URL(databaseUrl); } catch { return undefined; }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return undefined;
  if (url.searchParams.has('sslmode')) return undefined;
  return { rejectUnauthorized: env.PGSSL_NO_VERIFY !== '1' };
}

/** Migrations prefer the direct (unpooled) URL when the platform provides one, e.g. Vercel's Neon integration. */
export function migrationDatabaseUrl(env = process.env) {
  return env.DATABASE_URL_UNPOOLED?.trim() || env.DATABASE_URL?.trim() || undefined;
}
