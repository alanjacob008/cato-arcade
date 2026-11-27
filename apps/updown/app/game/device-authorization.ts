import { Account, BaseOrderlyKeyPair } from '@orderly.network/core';
import { createAutomationKey } from './automation-key';

type Context = { address: string; accountId: string; baseUrl: string; brokerId: string };
type Authorization = Awaited<ReturnType<typeof createAutomationKey>>;
type SavedAuthorization = Authorization & { version: 1; context: Context };
const prefix = 'updown:device-authorization:v1:';

function contextFor(account: Account, brokerId: string): Context {
  const baseUrl = account.apiBaseUrl?.replace(/\/$/, '');
  if (!account.address || !account.mainAccountId || account.isSubAccount) throw new Error('Connect your main account before playing.');
  if (!baseUrl || !['https://api.orderly.org', 'https://testnet-api.orderly.org'].includes(baseUrl) || !brokerId) throw new Error('Device authorization is unavailable on this network.');
  // Preserve case: Solana addresses are case-sensitive.
  return { address: account.address, accountId: account.mainAccountId, baseUrl, brokerId };
}

/** Dedicated game key only. Browser persistence follows the SDK's localStorage
 * model; it is not an encrypted vault and never contains a wallet private key.
 * A fresh manager simulates a page reload; persistent keys must be verified again.
 */
export function createDeviceAuthorizationManager() {
  const memory = new Map<string, SavedAuthorization>();
  const memoryOnly = new Set<string>();
  const queued = new Map<string, Promise<Authorization>>();

  function remove(name: string) {
    memory.delete(name);
    memoryOnly.delete(name);
    try { localStorage.removeItem(name); } catch { /* Storage may be unavailable. */ }
  }
  function read(name: string): SavedAuthorization | undefined {
    if (memoryOnly.has(name)) return memory.get(name);
    try {
      const raw = localStorage.getItem(name);
      if (raw) {
        try { return JSON.parse(raw); }
        catch { remove(name); return; }
      }
      // Honor cleared browser data instead of silently restoring it from RAM.
      memory.delete(name); return;
    } catch { /* Private/restricted browsers can still use this page's memory. */ }
    return memory.get(name);
  }
  function save(name: string, value: SavedAuthorization) {
    memory.set(name, value);
    try { localStorage.setItem(name, JSON.stringify(value)); memoryOnly.delete(name); }
    catch { memoryOnly.add(name); }
  }

  async function validate(saved: SavedAuthorization, context: Context, requiredUntil: number) {
    let publicKey: string;
    try { publicKey = await new BaseOrderlyKeyPair(saved.secretKey).getPublicKey(); }
    catch { return false; }
    if (publicKey !== `ed25519:${saved.key}`) return false;
    let response: Response;
    try {
      const query = new URLSearchParams({ account_id: context.accountId, orderly_key: publicKey });
      response = await fetch(`${context.baseUrl}/v1/get_orderly_key?${query}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    } catch { throw new Error('Could not check device authorization. Please try again when connected.'); }
    // A missing key can be replaced. Outages/rate limits must never discard a
    // valid saved key or create another wallet prompt as a side effect.
    let result;
    try { result = await response.json(); }
    catch { throw new Error('Could not check device authorization. Please try again.'); }
    // Verified public API response for an unregistered/deleted key. Generic
    // HTTP errors (including 404) are not evidence that this key was revoked.
    if (response.ok && result.success === false && result.code === -1617) return false;
    if (!response.ok || !result.success) throw new Error('Could not check device authorization. Please try again.');
    const info = result.data;
    if (!info || info.orderly_key !== publicKey || typeof info.scope !== 'string' || typeof info.key_status !== 'string' || !Number.isSafeInteger(Number(info.expiration))) throw new Error('Device authorization returned an incomplete response. Please try again.');
    const scopes = info.scope.split(',').map((scope: string) => scope.trim());
    const valid = info.key_status === 'ACTIVE' && Number(info.expiration) > requiredUntil
      && scopes.includes('read') && scopes.includes('trading') && scopes.every((scope: string) => ['read', 'trading'].includes(scope));
    if (valid) saved.expiresAt = Number(info.expiration);
    return valid;
  }

  return async function getDeviceAuthorization(account: Account, brokerId: string, requiredUntil = Date.now() + 360000, allowCreate = true): Promise<Authorization> {
    const context = contextFor(account, brokerId);
    const identity = JSON.stringify(context);
    const name = prefix + encodeURIComponent(identity);
    const assertCurrent = () => {
      if (JSON.stringify(contextFor(account, brokerId)) !== identity) throw new Error('Your wallet or network changed. Choose a direction again.');
    };
    if (!Number.isFinite(requiredUntil)) throw new Error('Invalid authorization deadline.');
    const run = async () => {
      assertCurrent();
      const minimumExpiry = Math.max(requiredUntil, Date.now() + 60000);
      const saved = read(name);
      if (saved && saved.version === 1 && JSON.stringify(saved.context) === identity
        && typeof saved.secretKey === 'string' && typeof saved.key === 'string'
        && Number.isSafeInteger(saved.expiresAt) && saved.expiresAt > minimumExpiry) {
        if (await validate(saved, context, minimumExpiry)) {
          assertCurrent(); save(name, saved); return saved;
        }
      }
      assertCurrent();
      if (!allowCreate) throw new Error('No saved device authorization is available for this account.');
      remove(name);
      const created = await createAutomationKey(account, brokerId);
      assertCurrent();
      if (created.expiresAt <= Math.max(requiredUntil, Date.now() + 60000)) throw new Error('Authorization expires before this round can finish.');
      save(name, { ...created, version: 1, context });
      return created;
    };
    // Serialize both within this page and, when supported, between same-origin
    // tabs. The second tab restores the first tab's key instead of asking twice.
    const previous = queued.get(name) || Promise.resolve();
    const task = previous.catch(() => undefined).then(() =>
      typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request(name, run) : run());
    queued.set(name, task);
    try { const key = await task; assertCurrent(); return key; }
    finally { if (queued.get(name) === task) queued.delete(name); }
  };
}

export const getDeviceAuthorization = createDeviceAuthorizationManager();
