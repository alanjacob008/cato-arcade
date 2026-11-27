/**
 * Server-side runtime for the Up Down round service inside the website: one pg
 * pool, store and engine per serverless instance, created on first use. The
 * engine and routes are the game's own (apps/updown/server); only the hosting
 * differs from the local worker. Node runtime only.
 */
import pg from "pg";
import { createOrderly } from "../../updown/server/orderly.mjs";
import { createPostgresStore } from "../../updown/server/postgres-store.mjs";
import { ensureMigrated } from "../../updown/server/migrate.mjs";
import { migrationDatabaseUrl, pgSsl } from "../../updown/server/pg-ssl.mjs";
import { RoundEngine, ROUND_DURATIONS } from "../../updown/server/engine.mjs";
import { createGameApi } from "../../updown/server/service.mjs";
import { createNetworkSweeper } from "../../updown/server/sweeper.mjs";
import { ORDERLY_API, parseDeploymentNetwork } from "../../updown/app/utils/deployment-network.mjs";
import { MIGRATIONS } from "./updownMigrations.generated.mjs";

/** A missing or invalid server setting. The message names the setting, never its value. */
export class UpdownConfigError extends Error {}

export type Network = "mainnet" | "testnet";

export interface UpdownConfig {
  network: Network;
  brokerId: string;
  orderlyBase: string;
}

/**
 * The same public values the game bundle is built with (VITE_*), read at runtime
 * through the bundle's own parser (apps/updown/app/utils/deployment-network.mjs):
 * unset = testnet; anything but "mainnet"/"testnet" is a config error, never a guess.
 */
export function updownConfig(env: NodeJS.ProcessEnv = process.env): UpdownConfig {
  let network: Network;
  try {
    network = parseDeploymentNetwork(env.VITE_DEPLOYMENT_ENV);
  } catch (error) {
    throw new UpdownConfigError((error as Error).message);
  }
  return {
    network,
    brokerId: env.VITE_ORDERLY_BROKER_ID?.trim() || "demo",
    orderlyBase: ORDERLY_API[network],
  };
}

/** A Vercel deployment other than Production (Preview, Development), if this is one. */
function nonProductionVercelEnv(env: NodeJS.ProcessEnv): string | undefined {
  const vercelEnv = env.VERCEL_ENV?.trim();
  return vercelEnv && vercelEnv !== "production" ? vercelEnv : undefined;
}

const previewAllowed = (env: NodeJS.ProcessEnv) => env.UPDOWN_ALLOW_PREVIEW_MAINNET?.trim() === "1";

/**
 * Preview deployments must not trade real money with Production's secrets
 * (DATABASE_URL, UPDOWN_JOURNAL_KEY). Mainnet play is refused on any
 * non-production Vercel deployment unless UPDOWN_ALLOW_PREVIEW_MAINNET=1.
 * Returns the reason to refuse, or null. Throws UpdownConfigError on a bad network value.
 */
export function previewRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const vercelEnv = nonProductionVercelEnv(env);
  if (!vercelEnv || previewAllowed(env) || updownConfig(env).network !== "mainnet") return null;
  return `Up Down does not play on mainnet from a ${vercelEnv} deployment. Use testnet (VITE_DEPLOYMENT_ENV=testnet) with its own database and journal key, or set UPDOWN_ALLOW_PREVIEW_MAINNET=1.`;
}

/**
 * The cron sweep advances every network's rounds, so on a non-production
 * deployment it refuses outright unless UPDOWN_ALLOW_PREVIEW_MAINNET=1. Returns
 * the reason to refuse, or null.
 */
export function sweepRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const vercelEnv = nonProductionVercelEnv(env);
  if (!vercelEnv || previewAllowed(env)) return null;
  return `The Up Down sweep only runs on the Production deployment (this is ${vercelEnv}). Set UPDOWN_ALLOW_PREVIEW_MAINNET=1 to allow it here.`;
}

/**
 * True when this deployment serves the game: the bundle was built into
 * public/updown (next.config.mjs sets UPDOWN_BUNDLE at build time), or local dev.
 */
export function updownEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // The literal `process.env.UPDOWN_BUNDLE` is what next.config's build-time `env` replaces.
  const bundle = env === process.env ? process.env.UPDOWN_BUNDLE === "1" : env.UPDOWN_BUNDLE === "1";
  return bundle || env.NODE_ENV !== "production";
}

/** 32-byte key that seals each round's trading credential in the database. */
export function journalKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env.UPDOWN_JOURNAL_KEY?.trim();
  if (!hex) throw new UpdownConfigError("UPDOWN_JOURNAL_KEY is not set (64 hex characters).");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new UpdownConfigError("UPDOWN_JOURNAL_KEY must be 64 hex characters (32 bytes).");
  return Buffer.from(hex, "hex");
}

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new UpdownConfigError(
      "DATABASE_URL is not set. Up Down rounds need the website database (Vercel Storage → Neon Postgres).",
    );
  }
  return url;
}

type Request = (path: string, credential?: unknown, method?: string, body?: unknown) => Promise<any>;

export interface UpdownRuntime {
  config: UpdownConfig;
  request: Request;
  store: ReturnType<typeof createPostgresStore>;
  engine: RoundEngine;
  /** Ticks this network's rounds and any still live on another network (used by the cron sweep). */
  sweeper: ReturnType<typeof createNetworkSweeper>;
  api: ReturnType<typeof createGameApi>;
}

async function createRuntime(env: NodeJS.ProcessEnv): Promise<UpdownRuntime> {
  const config = updownConfig(env);
  const refusal = previewRefusal(env);
  if (refusal) throw new UpdownConfigError(refusal);
  const url = databaseUrl(env);
  const key = journalKey(env);
  // DATABASE_URL may be a transaction-mode pooler (Neon's default). Everything here
  // is pooler-safe: no session state, no named prepared statements, and locks are
  // single-statement lease rows (see postgres-store.mjs). TLS: see pg-ssl.mjs.
  const pool = new pg.Pool({
    connectionString: url,
    ssl: pgSsl(url, env),
    // Small per instance: serverless instances are many and short-lived.
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  // An idle client dropped by the server (e.g. Neon scaling to zero) must not crash the instance.
  pool.on("error", () => {});
  // Idempotent and locked; set UPDOWN_AUTO_MIGRATE=0 to apply db/*.sql only via `npm run migrate` in apps/updown.
  // Over the direct URL (DATABASE_URL_UNPOOLED) when the platform provides one.
  if (env.UPDOWN_AUTO_MIGRATE !== "0") {
    const migrationUrl = migrationDatabaseUrl(env) ?? url;
    const migrator = new pg.Pool({ connectionString: migrationUrl, ssl: pgSsl(migrationUrl, env), max: 1, connectionTimeoutMillis: 10_000 });
    migrator.on("error", () => {});
    try {
      // A failed migration run is tolerated only when the ledger (read over the
      // regular pool) already lists every bundled migration.
      await ensureMigrated({ connect: () => migrator.connect(), query: (text: string) => pool.query(text), files: MIGRATIONS });
    } catch (error) {
      await pool.end().catch(() => {});
      throw error;
    } finally {
      await migrator.end().catch(() => {});
    }
  }
  const request = createOrderly(config.orderlyBase) as Request;
  const store = createPostgresStore({ pool, key });
  // minTickMs: players' polls and the cron sweep share the work; keep exchange
  // reads and the repeated flat-position checks about one second apart, as the
  // single local worker's 1s timer did.
  const engine = new RoundEngine({ request, store, network: config.network, brokerId: config.brokerId, minTickMs: 900 });
  // Rounds left live on the other network keep being closed by the sweep (with
  // that network's Orderly base), never stranded. Mainnet stays off-limits to
  // non-production deployments here too.
  const allowNetwork = (network: string) => network !== "mainnet" || !nonProductionVercelEnv(env) || previewAllowed(env);
  const sweeper = createNetworkSweeper({ store, primary: engine, allowNetwork });
  const others = (await store.activeNetworks().catch(() => [] as string[])).filter((n: string) => n !== config.network);
  if (others.length) {
    console.warn(`Up Down: playing on ${config.network}, but rounds on ${others.join(", ")} still have work; the sweep keeps closing them.`);
  }
  const api = createGameApi({
    engine,
    request,
    brokerId: config.brokerId,
    tickOnRead: true,
    health: async () => ({
      ready: true,
      network: config.network,
      journal: "database",
      time: Date.now(),
      timeExtensions: true,
      roundDurations: ROUND_DURATIONS,
    }),
  });
  return { config, request, store, engine, sweeper, api };
}

let runtime: Promise<UpdownRuntime> | undefined;

/** The instance's runtime; a failed start (bad config, database down) is retried on the next call. */
export function getUpdownRuntime(env: NodeJS.ProcessEnv = process.env): Promise<UpdownRuntime> {
  if (!runtime) {
    runtime = createRuntime(env).catch((error) => {
      runtime = undefined;
      throw error;
    });
  }
  return runtime;
}
