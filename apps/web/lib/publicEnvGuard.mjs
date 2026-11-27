// Browser-exposed variables (NEXT_PUBLIC_* in Next.js, VITE_* in the Up Down game) are
// inlined into public JavaScript at build time. A keyed RPC URL there publishes the key to
// every visitor. Fail the build instead, naming the variable but never printing its value.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_)/;
/** A name that says the value is a credential (public IDs such as *_PROJECT_ID or *_APP_ID are fine). */
const SECRET_NAME = /(SECRET|PASSWORD|PRIVATE[-_]?KEY|API[-_]?KEY|APIKEY|ACCESS[-_]?TOKEN|AUTH[-_]?TOKEN)/i;
/** Value shapes that carry a credential: query keys/tokens, URL userinfo, and providers that put the token in the path. */
const KEYED_VALUES = [
  /[?&;](api[-_]?key|apikey|key|access[-_]?token|auth[-_]?token|token|secret|password)=/i,
  /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i,
  /\.quiknode\.pro\/[^/?#\s]{8,}/i,
  /rpcpool\.com\/[^/?#\s]{8,}/i,
  /alchemy\.com\/v2\/[^/?#\s]{8,}/i,
  /ankr\.com\/[^/?#\s]+\/[0-9a-f]{32,}/i,
  /getblock\.io\/[^/?#\s]{16,}/i,
  /chainstack\.com\/[0-9a-f]{16,}/i,
];

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** @param {string} value */
export function looksKeyed(value) {
  const forms = [value, decoded(value)];
  return forms.some((form) => KEYED_VALUES.some((re) => re.test(form)));
}

/**
 * Names of browser-exposed variables whose values carry a credential.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function publicSecretVariables(env = process.env) {
  return Object.keys(env)
    .filter((name) => {
      if (!PUBLIC_PREFIX.test(name)) return false;
      const value = (env[name] ?? "").trim();
      if (!value) return false;
      return SECRET_NAME.test(name) || looksKeyed(value);
    })
    .sort();
}

/**
 * Browser-exposed variables defined in dotenv files that a bundler reads by itself
 * (Vite loads .env, .env.local, .env.<mode>, .env.<mode>.local from the app root).
 * Returns name -> value for NEXT_PUBLIC_* / VITE_* entries.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function publicDotenvValues(dir) {
  const out = {};
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
      let value = trimmed.slice(eq + 1).trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      if (PUBLIC_PREFIX.test(key)) out[key] = value;
    }
  }
  return out;
}

/** @param {Record<string, string | undefined>} [env] */
export function assertNoPublicSecrets(env = process.env) {
  const names = publicSecretVariables(env);
  if (!names.length) return;
  throw new Error(
    `Refusing to build: ${names.join(", ")} would publish a credential in browser JavaScript. ` +
      "Remove it from the public variables. RPC keys belong in server-only variables " +
      "(STAKE_RPC_URL or HELIUS_API_KEY); the browser uses the same-origin /api/rpc proxy.",
  );
}
