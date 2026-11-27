// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { Account, BaseOrderlyKeyPair } from '@orderly.network/core';
import { createAutomationKey } from './automation-key';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const key = BaseOrderlyKeyPair.generateKey();
  const generate = vi.fn(async (input: any) => ({ message: { ...input, expiration: input.timestamp + input.expiration * 86400000, chainType: 'SOL' }, signatured: 'test-signature' }));
  const account = { walletAdapter: { generateSecretKey: () => key.secretKey, generateAddOrderlyKeyMessage: generate }, address: 'test-wallet', mainAccountId: 'test-account', apiBaseUrl: 'https://testnet-api.orderly.org', isSubAccount: false } as unknown as Account;
  return { account, generate, key };
}
it('preserves an unsuccessful API response instead of the SDK generic error', async () => {
  const { account } = fixture();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, code: -1102, message: 'Invalid request parameter' }), { status: 200 })));
  await expect(createAutomationKey(account, 'demo')).rejects.toThrow('code -1102): Invalid request parameter');
});
it('uses the Solana/EVM wallet adapter, 365-day read/trading scope and no optional tag', async () => {
  const { account, generate, key } = fixture();
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const result = await createAutomationKey(account, 'demo');
  expect(generate.mock.calls[0][0]).toMatchObject({ brokerId: 'demo', expiration: 365, scope: 'read,trading' });
  expect(generate.mock.calls[0][0]).not.toHaveProperty('tag');
  const body = JSON.parse((fetchMock.mock.calls as any)[0][1].body);
  expect(body).toMatchObject({ userAddress: 'test-wallet', signature: 'test-signature', message: { chainType: 'SOL' } });
  expect(JSON.stringify(body)).not.toContain(key.secretKey);
  expect(result.secretKey).toBe(key.secretKey);
  expect(result.expiresAt).toBe(body.message.expiration);
  expect(body.message.expiration - body.message.timestamp).toBe(365 * 86400000);
});
it('does not register a key after the wallet cancels its signature', async () => {
  const { account, generate } = fixture(); generate.mockRejectedValue(new Error('User rejected request'));
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  await expect(createAutomationKey(account, 'demo')).rejects.toThrow('cancelled');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('reports an unconfirmed network response without automatically retrying', async () => {
  const { account } = fixture(); const fetchMock = vi.fn().mockRejectedValue(new Error('Network error')); vi.stubGlobal('fetch', fetchMock);
  await expect(createAutomationKey(account, 'demo')).rejects.toThrow('Could not confirm authorization');
  expect(fetchMock).toHaveBeenCalledOnce();
});
