// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { BaseOrderlyKeyPair } from '@orderly.network/core';
import { base58Decode, base58Encode, orderlyKeyPair } from './keys.mjs';

describe('Orderly key signing without the browser SDK', () => {
  it('matches BaseOrderlyKeyPair public keys and signatures', async () => {
    for (let i = 0; i < 25; i++) {
      const sdk = BaseOrderlyKeyPair.generateKey();
      const ours = orderlyKeyPair(sdk.secretKey);
      expect(ours.publicKey).toBe(await sdk.getPublicKey());
      const message = `${Date.now()}POST/v1/order{"i":${i}}`;
      expect(Buffer.from(ours.sign(message))).toEqual(Buffer.from(await sdk.sign(new TextEncoder().encode(message))));
    }
  });
  it('round-trips base58 including leading zero bytes', () => {
    for (const hex of ['', '00', '0000ff', '00010203', 'ffffffff', '0'.repeat(64)]) {
      const bytes = Buffer.from(hex, 'hex');
      expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    }
    expect(base58Encode(Buffer.alloc(32))).toBe('1'.repeat(32));
  });
  it('rejects malformed secrets', () => {
    expect(() => orderlyKeyPair('not-base58-0OIl')).toThrow('Invalid Orderly key');
    expect(() => orderlyKeyPair('abc')).toThrow('Invalid Orderly key');
  });
});
