import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

// Orderly keys are Ed25519. The browser SDK stores the 32-byte private seed as
// base58 and publishes the public key as `ed25519:<base58>`. This is the same
// scheme as BaseOrderlyKeyPair from @orderly.network/core, implemented on
// node:crypto so the round service (also bundled into the website's serverless
// functions) does not need the browser SDK. keys.test.ts checks it against the SDK.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));
// PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function base58Encode(bytes) {
  const input = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  const digits = [];
  for (const byte of input.subarray(zeros)) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map(d => ALPHABET[d]).join('');
}

export function base58Decode(text) {
  if (typeof text !== 'string') throw new Error('Invalid Orderly key.');
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes = [];
  for (const char of text.slice(zeros)) {
    let carry = INDEX.get(char);
    if (carry === undefined) throw new Error('Invalid Orderly key.');
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

/** Ed25519 key pair from an Orderly secret key (base58 32-byte seed). */
export function orderlyKeyPair(secretKey) {
  const seed = base58Decode(secretKey);
  if (seed.length !== 32) throw new Error('Invalid Orderly key.');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const raw = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    publicKey: `ed25519:${base58Encode(raw)}`,
    /** Signature bytes over a string or bytes message. */
    sign: message => new Uint8Array(sign(null, typeof message === 'string' ? Buffer.from(message) : Buffer.from(message), privateKey)),
  };
}
