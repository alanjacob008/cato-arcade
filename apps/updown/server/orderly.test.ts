// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { BaseOrderlyKeyPair } from '@orderly.network/core';
import { createOrderly } from './orderly.mjs';
afterEach(() => vi.unstubAllGlobals());
it('signs the exact timestamp, path and order body with the authorized Orderly key', async () => {
  const key = BaseOrderlyKeyPair.generateKey();
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { order_id: 123 } }) }));
  vi.stubGlobal('fetch', fetchMock);
  const order = { symbol: 'PERP_SOL_USDC', side: 'SELL', order_type: 'MARKET', order_quantity: 1, reduce_only: true, margin_mode: 'ISOLATED' };
  const request = createOrderly('https://testnet-api.orderly.org');
  await request('/v1/order', { accountId: 'test-account', secretKey: key.secretKey }, 'POST', order);
  const [url, options] = (fetchMock.mock.calls as any)[0];
  expect(url).toBe('https://testnet-api.orderly.org/v1/order');
  expect(options.headers['orderly-key']).toBe(await key.getPublicKey());
  const message = options.headers['orderly-timestamp'] + 'POST/v1/order' + JSON.stringify(order);
  expect(options.headers['orderly-signature']).toBe(Buffer.from(await key.sign(new TextEncoder().encode(message))).toString('base64url'));
  expect(options.body).not.toContain(key.secretKey);
});
