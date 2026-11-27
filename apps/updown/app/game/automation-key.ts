import { Account, BaseOrderlyKeyPair, utils } from '@orderly.network/core';

/** Use the SDK wallet adapter for signing, but preserve Orderly's registration error.
 * Account.createApiKey in SDK 3.1.11 discards unsuccessful response details.
 * No existing browser trading key is exported and the generated secret is never logged.
 */
export async function createAutomationKey(account: Account, brokerId: string) {
  const wallet = account.walletAdapter;
  const address = account.address;
  const accountId = account.mainAccountId;
  const baseUrl = account.apiBaseUrl;
  if (!wallet || !address || !accountId) throw new Error('Reconnect your wallet and enable trading before authorizing a round.');
  if (account.isSubAccount) throw new Error('Use your main account for this draft.');
  if (!baseUrl || !['https://api.orderly.org', 'https://testnet-api.orderly.org'].includes(baseUrl.replace(/\/$/, ''))) throw new Error('Unsupported Orderly network for round authorization.');
  const pair = new BaseOrderlyKeyPair(wallet.generateSecretKey());
  let signed;
  try {
    signed = await wallet.generateAddOrderlyKeyMessage({
      brokerId, publicKey: await pair.getPublicKey(), expiration: 365,
      timestamp: utils.getTimestamp(), scope: 'read,trading',
      // A tag is optional; omit it from the dedicated round authorization.
    });
  } catch (error) {
    if (/reject|denied|cancel/i.test(String(error))) throw new Error('Wallet authorization was cancelled. No round was submitted.');
    throw error;
  }
  if (account.address !== address || account.mainAccountId !== accountId || account.apiBaseUrl !== baseUrl) throw new Error('Your wallet or network changed during authorization. Please review the round again.');
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/orderly_key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-Id': accountId },
      body: JSON.stringify({ signature: signed.signatured, message: signed.message, userAddress: address }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new Error('Could not confirm authorization with Orderly. No round was submitted. Check your connection before trying again.');
  }
  let result: { success?: boolean; code?: number | string; message?: string };
  try { result = await response.json(); }
  catch { throw new Error(`Orderly authorization returned an unreadable response (HTTP ${response.status}). No round was submitted.`); }
  if (!response.ok || !result.success) {
    const code = result.code != null ? `code ${result.code}` : `HTTP ${response.status}`;
    const reason = typeof result.message === 'string' ? result.message.slice(0, 500) : 'No reason supplied by Orderly';
    throw new Error(`Orderly rejected round authorization (${code}): ${reason}. No round was submitted.`);
  }
  // Use the expiry the wallet actually signed, not a new clock-based estimate.
  const expiresAt = Number(signed.message.expiration);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('The authorization expiry could not be confirmed. No round was submitted.');
  return { secretKey: pair.secretKey, key: (await pair.getPublicKey()).replace('ed25519:', ''), expiresAt };
}
