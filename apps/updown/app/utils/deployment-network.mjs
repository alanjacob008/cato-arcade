// The one place VITE_DEPLOYMENT_ENV is interpreted. Shared by the browser bundle
// (orderly-urls.ts), the Vite build (vite.config.ts), the local worker
// (server/index.mjs) and the website's round service and build
// (apps/web/lib/updownRuntime.ts, apps/web/scripts/build-updown.mjs), so the game
// and its round service can never silently run on different Orderly networks.
// Plain JS: it is imported from config files and Node scripts as well as TS.

/** Orderly REST base URL per network. */
export const ORDERLY_API = Object.freeze({
  mainnet: 'https://api.orderly.org',
  testnet: 'https://testnet-api.orderly.org',
});

/** An unusable network setting. The message names the setting and the allowed values. */
export class DeploymentNetworkError extends Error {}

/**
 * VITE_DEPLOYMENT_ENV -> 'mainnet' | 'testnet'. Trimmed and case-insensitive.
 * Unset or empty means testnet (a fresh checkout). Anything else throws: an
 * unknown value must never fall through to real-money mainnet, or to a network
 * other than the one the round service uses.
 * @param {unknown} value
 * @returns {'mainnet' | 'testnet'}
 */
export function parseDeploymentNetwork(value) {
  const normalized = value == null ? '' : String(value).trim().toLowerCase();
  if (normalized === '') return 'testnet';
  if (normalized === 'mainnet' || normalized === 'testnet') return normalized;
  throw new DeploymentNetworkError(
    `VITE_DEPLOYMENT_ENV must be "mainnet" or "testnet" (got ${JSON.stringify(String(value).slice(0, 40))}).`,
  );
}

/**
 * Build-time check of the game's public network settings (VITE_*). Returns the
 * network. On mainnet the bundle's own network picker (the Orderly SDK provider)
 * only stays on mainnet when VITE_DISABLE_MAINNET=false and
 * VITE_DISABLE_TESTNET=true; anything else would let the page trade on testnet
 * while the round service closes on mainnet, so the build fails instead.
 * @param {Record<string, string | undefined>} env
 */
export function validateGameNetworkEnv(env) {
  const network = parseDeploymentNetwork(env.VITE_DEPLOYMENT_ENV);
  if (network === 'mainnet') {
    // Exactly as the bundle reads them (runtime-config.ts: unset VITE_DISABLE_MAINNET
    // defaults to "true"; a flag is on only when it is the string "true").
    const disableMainnet = (env.VITE_DISABLE_MAINNET || 'true') === 'true';
    const disableTestnet = env.VITE_DISABLE_TESTNET === 'true';
    if (disableMainnet || !disableTestnet) {
      throw new DeploymentNetworkError(
        'VITE_DEPLOYMENT_ENV=mainnet needs VITE_DISABLE_MAINNET=false and VITE_DISABLE_TESTNET=true, so the game page cannot switch to testnet while its rounds run on mainnet.',
      );
    }
  }
  return network;
}
