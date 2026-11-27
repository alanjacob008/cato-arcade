// How /updown (the game SPA) and /game-api (its round service) are served.
// Plain .mjs so next.config.mjs can import it without a TypeScript step.
//
// Production (`next build`, Vercel): the SPA is built into public/updown by
// scripts/build-updown.mjs and served as static files with an SPA fallback;
// /game-api is the site's own route handler. Nothing is proxied.
// Local `next dev`: /updown proxies to the game's Vite dev server (HMR), and
// /game-api is the route handler unless UPDOWN_WORKER_ORIGIN points at the
// game's standalone local worker.

const DEV_DEFAULTS = {
  UPDOWN_ORIGIN: "http://127.0.0.1:5185",
};

/** True for a production build/server: `next build`, `next start`, or any Vercel build. */
export function isProductionBuild(env = process.env) {
  return env.NODE_ENV === "production" || env.VERCEL === "1" || Boolean(env.VERCEL_ENV);
}

/**
 * Dev-only proxy origin. Production never proxies the game anywhere.
 *
 * @param {"UPDOWN_ORIGIN" | "UPDOWN_WORKER_ORIGIN"} name
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function resolveUpdownOrigin(name, env = process.env) {
  if (isProductionBuild(env)) return null;
  const explicit = env[name]?.trim().replace(/\/+$/, "");
  return explicit || DEV_DEFAULTS[name] || null;
}

/**
 * beforeFiles rewrites (dev only): they run ahead of public files and the app's
 * own /updown page and /game-api handler.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function updownRewrites(env = process.env) {
  const origin = resolveUpdownOrigin("UPDOWN_ORIGIN", env);
  const worker = resolveUpdownOrigin("UPDOWN_WORKER_ORIGIN", env);
  return [
    ...(origin
      ? [
          { source: "/updown", destination: `${origin}/updown/` },
          { source: "/updown/:path*", destination: `${origin}/updown/:path*` },
        ]
      : []),
    ...(worker ? [{ source: "/game-api/:path*", destination: `${worker}/game-api/:path*` }] : []),
  ];
}

/**
 * Serving the built SPA from public/updown (production, when the bundle exists).
 * afterFiles runs after real public files, so /updown/assets/x.js is the file and
 * every other /updown path (client routes) gets index.html. Missing hashed assets
 * get a 404 instead of HTML. Cache headers are set by middleware.ts.
 */
export function updownBundleRewrites(bundle) {
  if (!bundle) return [];
  return [
    { source: "/updown", destination: "/updown/index.html" },
    // A missing hashed asset is a plain 404 (never cached), not HTML.
    { source: "/updown/assets/:path*", destination: "/api/updown/missing" },
    { source: "/updown/:path((?!assets/).*)", destination: "/updown/index.html" },
  ];
}
