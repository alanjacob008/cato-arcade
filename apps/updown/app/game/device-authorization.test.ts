// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Account, BaseOrderlyKeyPair } from '@orderly.network/core';
import { createDeviceAuthorizationManager } from './device-authorization';

const { createKey } = vi.hoisted(() => ({ createKey: vi.fn() }));
vi.mock('./automation-key', () => ({ createAutomationKey: createKey }));
const year = 365 * 86400000;
let values: Map<string, string>;
let account: Account;
let fetchMock: ReturnType<typeof vi.fn>;
let expiration: number;
let status: string;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
  values = new Map(); status = 'ACTIVE'; expiration = Date.now() + year;
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
    removeItem: (name: string) => values.delete(name),
  });
  account = { address: 'wallet-A', mainAccountId: 'account-A', apiBaseUrl: 'https://api.orderly.org', isSubAccount: false } as unknown as Account;
  createKey.mockReset().mockImplementation(async () => {
    const pair = BaseOrderlyKeyPair.generateKey();
    return { secretKey: pair.secretKey, key: (await pair.getPublicKey()).replace('ed25519:', ''), expiresAt: Date.now() + year };
  });
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify({ success: true, data: {
    orderly_key: new URL(url).searchParams.get('orderly_key'), scope: 'read,trading', expiration, key_status: status,
  } })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('persistent device authorization', () => {
  it('never opens a wallet prompt for background result recovery', async () => {
    const get = createDeviceAuthorizationManager();
    await expect(get(account, 'cato', Date.now() + 60000, false)).rejects.toThrow('No saved device authorization');
    expect(createKey).not.toHaveBeenCalled();
    const key = await get(account, 'cato');
    expect((await get(account, 'cato', Date.now() + 60000, false)).secretKey).toBe(key.secretKey);
    expect(createKey).toHaveBeenCalledOnce();
    status = 'REVOKED';
    await expect(get(account, 'cato', Date.now() + 60000, false)).rejects.toThrow('No saved device authorization');
    expect(createKey).toHaveBeenCalledOnce();
  });
  it('signs once and restores the same key after a new page session days later', async () => {
    const first = await createDeviceAuthorizationManager()(account, 'cato');
    expect(createKey).toHaveBeenCalledOnce(); expect(values.size).toBe(1);
    vi.mocked(Date.now).mockReturnValue(Date.now() + 2 * 86400000);
    const restored = await createDeviceAuthorizationManager()(account, 'cato');
    expect(restored.secretKey).toBe(first.secretKey);
    expect(restored.expiresAt).toBe(expiration);
    expect(createKey).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(new URL(url).searchParams.get('account_id')).toBe('account-A');
    expect(JSON.stringify([url, options])).not.toContain(first.secretKey);
  });
  it('shares a single creation between concurrent round and extension requests', async () => {
    const get = createDeviceAuthorizationManager();
    const [one, two] = await Promise.all([get(account, 'cato'), get(account, 'cato', Date.now() + 300000)]);
    expect(one.secretKey).toBe(two.secretKey); expect(createKey).toHaveBeenCalledOnce();
  });
  it('serializes separate tab managers with Web Locks and restores the first tab key', async () => {
    let queue = Promise.resolve();
    const request = vi.fn((_name: string, run: () => Promise<unknown>) => {
      const task = queue.then(run); queue = task.then(() => undefined); return task;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    const [one, two] = await Promise.all([createDeviceAuthorizationManager()(account, 'cato'), createDeviceAuthorizationManager()(account, 'cato')]);
    expect(one.secretKey).toBe(two.secretKey); expect(createKey).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('keeps wallets, accounts, networks and brokers separate', async () => {
    const get = createDeviceAuthorizationManager();
    const first = await get(account, 'cato');
    for (const changes of [{ address: 'wallet-B' }, { mainAccountId: 'account-B' }, { apiBaseUrl: 'https://testnet-api.orderly.org' }]) {
      const result = await get({ ...account, ...changes } as Account, 'cato');
      expect(result.secretKey).not.toBe(first.secretKey);
    }
    await get(account, 'other-broker');
    expect(createKey).toHaveBeenCalledTimes(5); expect(values.size).toBe(5);
    expect((await get(account, 'cato')).secretKey).toBe(first.secretKey);
  });
  it('renews an expired key and a key that cannot cover the extended deadline', async () => {
    const get = createDeviceAuthorizationManager();
    const first = await get(account, 'cato');
    vi.mocked(Date.now).mockReturnValue(first.expiresAt - 120000);
    const renewed = await get(account, 'cato', first.expiresAt + 60000);
    expect(renewed.secretKey).not.toBe(first.secretKey);
    vi.mocked(Date.now).mockReturnValue(renewed.expiresAt + 1);
    await get(account, 'cato'); expect(createKey).toHaveBeenCalledTimes(3);
  });
  it('replaces a revoked key, with a new wallet authorization', async () => {
    const get = createDeviceAuthorizationManager();
    const first = await get(account, 'cato'); status = 'REMOVED';
    const second = await get(account, 'cato');
    expect(second.secretKey).not.toBe(first.secretKey); expect(createKey).toHaveBeenCalledTimes(2);
  });
  it('renews after the actual key-not-found response and rejects broader scopes', async () => {
    const get = createDeviceAuthorizationManager(); await get(account, 'cato');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, code: -1617, message: 'orderlyKey is not exist' })));
    const second = await get(account, 'cato'); expect(createKey).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: {
      orderly_key: `ed25519:${second.key}`, scope: 'read,trading,asset', key_status: 'ACTIVE', expiration,
    } })));
    await get(account, 'cato'); expect(createKey).toHaveBeenCalledTimes(3);
  });
  it('preserves a good key during network failures, rate limits and incomplete replies', async () => {
    const get = createDeviceAuthorizationManager(); await get(account, 'cato');
    const saved = [...values.values()][0];
    for (const response of [new Response('{}', { status: 429 }), new Response('{'), new Response(JSON.stringify({ success: true, data: {} }))]) {
      fetchMock.mockResolvedValueOnce(response);
      await expect(get(account, 'cato')).rejects.toThrow(/authorization/i);
      expect([...values.values()][0]).toBe(saved); expect(createKey).toHaveBeenCalledOnce();
    }
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(get(account, 'cato')).rejects.toThrow('connected');
    expect(createKey).toHaveBeenCalledOnce(); expect([...values.values()][0]).toBe(saved);
  });
  it('replaces corrupt local data instead of forwarding an invalid key', async () => {
    const get = createDeviceAuthorizationManager(); await get(account, 'cato');
    const name = [...values.keys()][0]; values.set(name, '{bad-json');
    await createDeviceAuthorizationManager()(account, 'cato');
    expect(createKey).toHaveBeenCalledTimes(2);
    const record = JSON.parse(values.get(name)!); record.secretKey = 'invalid'; values.set(name, JSON.stringify(record));
    await createDeviceAuthorizationManager()(account, 'cato');
    expect(createKey).toHaveBeenCalledTimes(3);
  });
  it('does not save an authorization when the wallet changes while signing', async () => {
    let release!: (value: unknown) => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    createKey.mockImplementationOnce(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = createDeviceAuthorizationManager()(account, 'cato');
    const rejection = expect(pending).rejects.toThrow('wallet or network changed');
    await entered;
    (account as any).address = 'wallet-B'; release({ secretKey: 'never-persist', key: 'test', expiresAt: Date.now() + year });
    await rejection; expect(values.size).toBe(0);
  });
  it('retains a working session without repeated signatures if browser storage is blocked', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } });
    const get = createDeviceAuthorizationManager();
    const first = await get(account, 'cato'); const second = await get(account, 'cato');
    expect(second.secretKey).toBe(first.secretKey); expect(createKey).toHaveBeenCalledOnce();
  });
  it('honors cleared site data even when this page had an in-memory copy', async () => {
    const get = createDeviceAuthorizationManager();
    const first = await get(account, 'cato'); values.clear();
    const second = await get(account, 'cato');
    expect(second.secretKey).not.toBe(first.secretKey); expect(createKey).toHaveBeenCalledTimes(2);
  });
});
