/** Client-side shape checks (mirror the API's validators). */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_DOMAIN = /^(?=.{5,64}$)[a-z0-9-]+(\.[a-z0-9-]+)*\.sol$/i;

export function isValidWallet(wallet: string): boolean {
  return BASE58.test(wallet.trim());
}

export function isSolDomain(input: string): boolean {
  return SOL_DOMAIN.test(input.trim());
}

/** Accept a base58 wallet or a `.sol` domain (the API resolves domains server-side). */
export function isValidWalletOrDomain(input: string): boolean {
  return isValidWallet(input) || isSolDomain(input);
}
