/** @type {import('next').NextConfig} */
import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { updownBundleRewrites, updownRewrites } from "./lib/updownOrigins.mjs";
import { assertNoPublicSecrets } from "./lib/publicEnvGuard.mjs";
import { securityHeaderRules } from "./lib/securityHeaders.mjs";

// Pull NEXT_PUBLIC_* vars from monorepo env files so the web app shares one config.
// Prefer apps/web/.env.local (Next built-in), then root .env, then packages/shared/.env.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  resolve(__dirname, ".env.local"),
  resolve(__dirname, "../../.env"),
  resolve(__dirname, "../../packages/shared/.env"),
];
for (const envPath of envCandidates) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key.startsWith("NEXT_PUBLIC_") && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
// Never inline a credential into the browser bundle (see lib/publicEnvGuard.mjs).
assertNoPublicSecrets();

// The Up Down game (apps/updown, a Vite SPA built with base "/updown/") and its
// round service are served by this app so they share the site origin: one wallet
// session, one cookie jar. middleware.ts gates both behind the beta sign-in.
// - scripts/build-updown.mjs (run by `npm run build`) builds the SPA into
//   public/updown. When that bundle exists at build time it is served with an SPA
//   fallback; without it, app/updown shows "coming online soon" and /game-api 503s.
// - /game-api is app/game-api's route handler (the game's engine, on Postgres).
// - `next dev` proxies /updown to the game's Vite dev server instead. See lib/updownOrigins.mjs.
const updownBundle = existsSync(resolve(__dirname, "public/updown/index.html"));
const clawBackendOrigin=process.env.CLAW_BACKEND_ORIGIN;
if(clawBackendOrigin){
  const url=new URL(clawBackendOrigin);
  if(url.origin!==clawBackendOrigin||url.protocol!=="https:"||url.username||url.password)throw Error("Invalid CLAW_BACKEND_ORIGIN");
}

const nextConfig = {
  poweredByHeader: false,
  async headers() {
    // Site-wide security headers (every page, API route and static file; see lib/securityHeaders.mjs).
    return [...securityHeaderRules(), ...["concrete-diffuse-v2.webp", "concrete-normal-v2.webp", "concrete-arm-v2.webp"].map(file => ({
      source: `/claw/${file}`, headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    }))];
  },
  // The workspace package ships TS source; let Next transpile it.
  transpilePackages: ["@cato/shared"],
  env: {
    // Read by lib/updownRuntime.ts (and so baked in at build time, like the bundle itself).
    UPDOWN_BUNDLE: updownBundle ? "1" : "",
  },
  // Trace serverless dependencies (pg) from the monorepo root, where npm hoists them.
  outputFileTracingRoot: resolve(__dirname, "../.."),
  serverExternalPackages: ["pg"],
  experimental: {
    // The round service imports the game's server modules from apps/updown.
    externalDir: true,
  },
  async rewrites() {
    return { beforeFiles: [...updownRewrites(),...(clawBackendOrigin?[{source:"/api/player/:path*",destination:`${clawBackendOrigin}/api/player/:path*`}]:[])], afterFiles: updownBundleRewrites(updownBundle) };
  },
  webpack: (config) => {
    // @cato/shared uses NodeNext-style ".js" import specifiers that actually
    // point at ".ts" source files. Teach webpack to resolve ".js" to the TS
    // source (falling back to real ".js") so those imports don't 404.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
