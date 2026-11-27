// Build the Up Down game SPA (apps/updown) into this app's public/updown, so the
// website serves it under /updown. Runs before `next build` in this app's build
// script, so it works whether Vercel builds from the repo root
// (`npm run build` → `npm run build -w @cato/web`) or from apps/web.
//
//   UPDOWN_SKIP_BUILD=1   skip (keeps an existing public/updown; without one,
//                         /updown shows "coming online soon" and /game-api 503s).
//                         Also the only way to build without apps/updown present.
//
// VITE_DEPLOYMENT_ENV must be "mainnet" or "testnet" (unset = testnet), read by the
// same parser as the game and its round service; anything else fails the build.
//   UPDOWN_BUILD_HEAP_MB  Node heap for the Vite build (default 6144; the 3D cat libraries push the bundle past 3072 on Vercel)
//
// The game's VITE_* values come from the environment (Vercel project env at build
// time) or, locally, from apps/updown/.env. VITE_BASE_URL is forced to /updown/.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeMigrations } from "./updown-migrations.mjs";
import { assertNoPublicSecrets, publicDotenvValues } from "../lib/publicEnvGuard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const game = resolve(web, "../updown");

// VITE_* values are inlined into the public game bundle; refuse to ship a credential,
// whether it comes from the build environment or from a dotenv file Vite reads itself.
assertNoPublicSecrets({ ...publicDotenvValues(game), ...process.env });
const target = join(web, "public/updown");
const log = (message) => console.log(`[updown] ${message}`);

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: game, stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status ?? result.signal}).`);
}

if (!existsSync(join(game, "package.json"))) {
  if (process.env.UPDOWN_SKIP_BUILD === "1") {
    log("apps/updown is not in this checkout; UPDOWN_SKIP_BUILD=1, so the site builds without the game.");
    process.exit(0);
  }
  console.error(
    "[updown] apps/updown is missing from this checkout, so the game cannot be built. On Vercel enable " +
      "\"Include files outside the root directory in the Build Step\", or set UPDOWN_SKIP_BUILD=1 to build the site without the game.",
  );
  process.exit(1);
}

// Plain JS from the game, shared with its bundle and round service.
const { parseDeploymentNetwork, validateGameNetworkEnv } = await import(
  pathToFileURL(join(game, "app/utils/deployment-network.mjs")).href
);
try {
  // The round service reads this at runtime; a value it would refuse fails here, at build time.
  log(`Network: ${parseDeploymentNetwork(process.env.VITE_DEPLOYMENT_ENV)}.`);
} catch (error) {
  console.error(`[updown] ${error.message}`);
  process.exit(1);
}

// The serverless round service bundles the game's SQL migrations.
writeMigrations();

if (process.env.UPDOWN_SKIP_BUILD === "1") {
  log(`UPDOWN_SKIP_BUILD=1: skipping the game build${existsSync(join(target, "index.html")) ? " (keeping the existing public/updown)" : " (no bundle: /updown will show \"coming online soon\")"}.`);
  process.exit(0);
}

// The game has its own lockfile and is not a root workspace.
const lock = readFileSync(join(game, "package-lock.json"));
const stamp = join(game, "node_modules/.updown-lock-hash");
const lockHash = createHash("sha256").update(lock).digest("hex");
if (!existsSync(stamp) || readFileSync(stamp, "utf8").trim() !== lockHash) {
  // --include=dev: the build tools (vite, tsx) are devDependencies, even if NODE_ENV=production.
  run("npm", ["ci", "--legacy-peer-deps", "--include=dev", "--no-audit", "--no-fund"]);
  writeFileSync(stamp, lockHash);
} else {
  log("apps/updown/node_modules matches its lockfile; skipping npm ci.");
}

const heap = Number(process.env.UPDOWN_BUILD_HEAP_MB) || 6144;
const env = { ...process.env, VITE_BASE_URL: "/updown/", NODE_OPTIONS: `--max-old-space-size=${heap}` };
if (!env.VITE_SEO_SITE_URL && env.VERCEL_PROJECT_PRODUCTION_URL) {
  // The public site URL for the game's SEO tags; Vercel provides the production domain.
  env.VITE_SEO_SITE_URL = `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  log(`VITE_SEO_SITE_URL not set; using ${env.VITE_SEO_SITE_URL}.`);
}
if (env.VERCEL) {
  const missing = ["VITE_ORDERLY_BROKER_ID", "VITE_ORDERLY_BROKER_NAME", "VITE_DEPLOYMENT_ENV", "VITE_SEO_SITE_URL"].filter((k) => !env[k]);
  if (missing.length) log(`WARNING: ${missing.join(", ")} not set; the game falls back to its defaults (testnet "demo" broker).`);
}

try {
  // The bundle must pick the same network as the round service.
  validateGameNetworkEnv(env);
} catch (error) {
  console.error(`[updown] ${error.message}`);
  process.exit(1);
}

run("npm", ["run", "generate:manifest"], { env });
run(process.execPath, [`--max-old-space-size=${heap}`, "node_modules/vite/bin/vite.js", "build"], { env, shell: false });

const built = join(game, "build/client");
if (!existsSync(join(built, "index.html"))) throw new Error("The game build produced no build/client/index.html.");
rmSync(target, { recursive: true, force: true });
cpSync(built, target, { recursive: true });
log(`Copied the game bundle to ${target}.`);
