// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { migrationDatabaseUrl, pgSsl } from './pg-ssl.mjs';

// pg's own resolution of { connectionString, ssl } -> the TLS options it would use. No connection is made.
const ConnectionParameters = createRequire(import.meta.url)('pg/lib/connection-parameters');
const resolved = (url: string, env: Record<string, string> = {}) => new ConnectionParameters({ connectionString: url, ssl: pgSsl(url, env) }).ssl;

describe('Postgres TLS and URLs', () => {
  it('verifies Neon certificates (sslmode=require is verify-full in pg 8), pooled or direct', () => {
    process.removeAllListeners('warning');
    for (const url of [
      'postgresql://u:p@ep-cool-name-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      'postgresql://u:p@ep-cool-name-123.us-east-1.aws.neon.tech/neondb?sslmode=require',
    ]) {
      expect(pgSsl(url)).toBeUndefined();
      const ssl = resolved(url);
      expect(ssl).toBeTruthy();
      expect(ssl.rejectUnauthorized).not.toBe(false);
    }
  });
  it('verifies other remote hosts unless told not to, and skips TLS only for loopback hosts', () => {
    expect(resolved('postgres://u:p@db.example.com/x')).toEqual({ rejectUnauthorized: true });
    expect(resolved('postgres://u:p@db.example.com/x', { PGSSL_NO_VERIFY: '1' })).toEqual({ rejectUnauthorized: false });
    for (const url of ['postgres://postgres@127.0.0.1:5432/updown_dev', 'postgres://postgres@localhost/updown_dev', 'postgres://p@[::1]:5432/x']) expect(resolved(url)).toBe(false);
    // A password that merely contains "localhost" is still a remote host.
    expect(resolved('postgres://u:localhost@db.example.com/x')).toEqual({ rejectUnauthorized: true });
  });
  it('runs migrations over the direct URL when one is provided', () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: 'pooled', DATABASE_URL_UNPOOLED: 'direct' })).toBe('direct');
    expect(migrationDatabaseUrl({ DATABASE_URL: 'pooled', DATABASE_URL_UNPOOLED: ' ' })).toBe('pooled');
    expect(migrationDatabaseUrl({})).toBeUndefined();
  });
});
