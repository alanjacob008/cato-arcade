// Security headers for every route, applied by next.config.mjs headers().
// Plain .mjs so next.config.mjs can import it without a TypeScript step.
//
// Every response gets two Content Security Policies:
// - Content-Security-Policy (ENFORCED): only directives nothing on the site needs:
//   no framing of our pages (every page hosts a wallet that can prompt signatures,
//   so clickjacking matters everywhere), no plugins, no <base> hijacking and no
//   form posts to other origins.
// - Content-Security-Policy-Report-Only: the full source allowlist. Not enforced
//   yet because the flows that pull in third-party code (Solflare's iframe, the
//   Jupiter plugin's own wallet kit, the Up Down game's Orderly / Privy /
//   WalletConnect stack) cannot all be exercised without a real wallet. Violations
//   appear in the browser console; move a directive into ENFORCED_DIRECTIVES once
//   a preview deployment that exercises those flows shows none.
//
// headers() is evaluated at build time, so NEXT_PUBLIC_* origins are baked in.

/** Origin of the Jupiter swap plugin script (components/JupiterSwap.tsx). */
export const JUPITER_PLUGIN_ORIGIN = "https://plugin.jup.ag";

/** Enforced on every route. */
export const ENFORCED_DIRECTIVES = Object.freeze({
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
});

/**
 * Turns off features nothing on the site uses. Fullscreen, autoplay (claw audio),
 * clipboard, WebHID/WebUSB (hardware wallets inside wallet iframes) and passkeys
 * are left at browser defaults on purpose.
 */
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), display-capture=()";

/** Directive map -> header value. Sources are de-duplicated, order kept. */
export function serializeCsp(directives) {
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...new Set(sources)].join(" "))
    .join("; ");
}

/** The http(s) origin of a URL-ish value, or null. */
export function originOf(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** An origin plus its ws(s) twin: web3.js opens its subscription socket on the RPC host. */
function withSocket(origin) {
  return origin ? [origin, origin.replace(/^http/, "ws")] : [];
}

const isDev = (env) => env.NODE_ENV === "development";

/**
 * Report-only allowlist for the Next.js pages (everything except the /updown game).
 * @param {Record<string, string | undefined>} [env]
 */
export function siteReportOnlyDirectives(env = process.env) {
  const dev = isDev(env);
  const apiOrigin = originOf(env.NEXT_PUBLIC_API_URL);
  return {
    "default-src": ["'self'"],
    // Next 14 inlines its bootstrap and RSC payload scripts. Without per-request
    // nonces (middleware + dynamic rendering of every page) that needs 'unsafe-inline'.
    // Vercel Analytics is same-origin (/_vercel/insights) outside development.
    "script-src": ["'self'", "'unsafe-inline'", JUPITER_PLUGIN_ORIGIN,
      ...(dev ? ["'unsafe-eval'", "https://va.vercel-scripts.com"] : [])],
    // The Jupiter plugin adds its own stylesheets and Google Fonts CSS.
    "style-src": ["'self'", "'unsafe-inline'", JUPITER_PLUGIN_ORIGIN, "https://fonts.googleapis.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    // Token logos (Jupiter's token list, on-chain metadata) are on arbitrary hosts.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "blob:"],
    "connect-src": [
      "'self'",
      // /api/rpc and its socket, explicitly (older Safari's 'self' does not cover wss:).
      ...withSocket(originOf(env.NEXT_PUBLIC_SITE_URL)),
      // Optional keyless browser RPC (devnet work) and the Wrapped API.
      ...withSocket(originOf(env.NEXT_PUBLIC_RPC_URL)),
      ...(apiOrigin ? [apiOrigin] : []),
      // Jupiter: lite-api (market data); api, ultra-api and worker (the swap plugin),
      // which also fetch()es its Google Fonts stylesheet.
      "https://*.jup.ag",
      "https://fonts.googleapis.com",
      ...(dev ? ["ws:", "http://localhost:8080", "https://va.vercel-scripts.com"] : []),
    ],
    // Solflare's web wallet opens in an iframe when its extension is not installed.
    "frame-src": ["'self'", "https://connect.solflare.com"],
    // The claw physics worker is a same-origin webpack chunk.
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    ...ENFORCED_DIRECTIVES,
  };
}

/**
 * Report-only policy for the Up Down game (apps/updown, served from public/updown).
 * Its Orderly SDK reaches dozens of chain RPCs, WalletConnect, Privy and Orderly
 * hosts, so network and frame sources stay broad; the useful signal is scripts:
 * the bundle has no inline scripts, so script-src omits 'unsafe-inline'.
 * @param {Record<string, string | undefined>} [env]
 */
export function updownReportOnlyDirectives(env = process.env) {
  const dev = isDev(env);
  return {
    "default-src": ["'self'"],
    // Observed on a local production build: a bundled function-bind shim calls
    // Function(...) at runtime ('unsafe-eval'), a three.js helper compiles WebAssembly,
    // and gtag is the optional GA4 analytics provider.
    "script-src": ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", "https://www.googletagmanager.com",
      ...(dev ? ["'unsafe-inline'", "http://127.0.0.1:5185"] : [])],
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.reown.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com", "https://fonts.reown.com"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "media-src": ["'self'", "data:", "blob:"],
    // The 3D cat overlay fetches blob: URLs.
    "connect-src": ["'self'", "blob:", "https:", "wss:", ...(dev ? ["ws:", "http:"] : [])],
    "frame-src": ["'self'", "https:"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    ...ENFORCED_DIRECTIVES,
  };
}

function baseHeaders(reportOnly) {
  return [
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
    { key: "Content-Security-Policy", value: serializeCsp(ENFORCED_DIRECTIVES) },
    { key: "Content-Security-Policy-Report-Only", value: serializeCsp(reportOnly) },
  ];
}

/**
 * next.config.mjs headers() entries. "/:path*" also matches "/", API routes and
 * static files. Next applies every matching entry in order and a later entry wins
 * for the same key, so the /updown entry only swaps the report-only policy.
 * @param {Record<string, string | undefined>} [env]
 */
export function securityHeaderRules(env = process.env) {
  return [
    { source: "/:path*", headers: baseHeaders(siteReportOnlyDirectives(env)) },
    { source: "/updown/:path*", headers: [
      { key: "Content-Security-Policy-Report-Only", value: serializeCsp(updownReportOnlyDirectives(env)) },
    ] },
  ];
}
