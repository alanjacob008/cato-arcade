/**
 * Up Down private-beta session: a signed, httpOnly cookie that says "this wallet
 * proved ownership and held enough CATO at sign-in". Runs in both the Edge
 * middleware and Node route handlers, so it only uses WebCrypto.
 */

export const SESSION_COOKIE = "updown_session";
export const NONCE_COOKIE = "updown_nonce";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const NONCE_TTL_MS = 10 * 60 * 1000;

/** Whole CATO a wallet must hold to enter the beta. */
export function vipThreshold(): number {
  const raw = Number(process.env.UPDOWN_VIP_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 50_000;
}

/** HMAC secret for the cookies. Production must set it; dev falls back to a fixed value. */
export function sessionSecret(): string {
  const explicit = process.env.UPDOWN_SESSION_SECRET?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === "production") throw new Error("UPDOWN_SESSION_SECRET is not set");
  return "updown-dev-only-secret";
}

export interface Session {
  wallet: string;
  /** Whole CATO held when the session was issued. */
  balance: number;
  /** Expiry, ms since epoch. */
  exp: number;
}

export interface Nonce {
  nonce: string;
  wallet: string;
  issuedAt: string;
  /** Host the nonce was issued for; the signed message names it. */
  domain: string;
  exp: number;
}

/**
 * The exact text the wallet signs, in Sign In With Solana form so it names this site:
 * a wallet that checks SIWS warns when another site asks for it, and a person reading
 * it can see where it belongs. Any change here invalidates in-flight sign-ins.
 */
export function buildSignInMessage(domain: string, wallet: string, nonce: string, issuedAt: string): string {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    "",
    "Sign in to Up Down on $CATO. This signature only proves you own this wallet. It does not approve any transaction.",
    "",
    `URI: https://${domain}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

const encoder = new TextEncoder();
/** UTF-8 bytes as a plain ArrayBuffer (what WebCrypto's typings want). */
const utf8 = (text: string): ArrayBuffer => encoder.encode(text).buffer as ArrayBuffer;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, utf8(data));
  return toBase64Url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * What a sealed token is for. The purpose is part of the MAC input, so a token
 * sealed for one purpose never opens as another: the unauthenticated sign-in
 * nonce (issued for any wallet on request) must never pass as a session.
 */
export type TokenPurpose = "session" | "nonce";

const macInput = (purpose: TokenPurpose, body: string) => `updown-${purpose}.v2.${body}`;

/** payload.signature, both base64url; the signature covers the purpose and the payload. */
export async function sealToken(payload: object, secret: string, purpose: TokenPurpose): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, macInput(purpose, body))}`;
}

/** Returns the payload when the signature is valid for `purpose` and `exp` is in the future, else null. */
export async function openToken<T extends { exp: number }>(
  token: string | undefined,
  secret: string,
  purpose: TokenPurpose,
  now: number = Date.now(),
): Promise<T | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const expected = await hmac(secret, macInput(purpose, body));
  if (!timingSafeEqual(token.slice(dot + 1), expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as T;
    if (typeof payload?.exp !== "number" || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** The signed-in session from its cookie value, or null. Checks purpose, expiry and shape. */
export async function openSession(token: string | undefined, now: number = Date.now()): Promise<Session | null> {
  const session = await openToken<Session>(token, sessionSecret(), "session", now);
  if (!session || typeof session.wallet !== "string" || !session.wallet || typeof session.balance !== "number") return null;
  return session;
}

/** The pending sign-in nonce from its cookie value, or null. Checks purpose, expiry and shape. */
export async function openNonce(token: string | undefined, now: number = Date.now()): Promise<Nonce | null> {
  const nonce = await openToken<Nonce>(token, sessionSecret(), "nonce", now);
  if (
    !nonce ||
    typeof nonce.nonce !== "string" ||
    typeof nonce.wallet !== "string" ||
    typeof nonce.issuedAt !== "string" ||
    typeof nonce.domain !== "string"
  )
    return null;
  return nonce;
}

export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
