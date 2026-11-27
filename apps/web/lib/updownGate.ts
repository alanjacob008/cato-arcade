/**
 * Server-side half of the Up Down beta gate: Ed25519 ownership proof and the
 * live CATO balance. Node runtime only (route handlers), never the middleware.
 */
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { CATO_MINT } from "@cato/shared";

// SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function isWalletAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return PublicKey.isOnCurve(new PublicKey(value).toBytes());
  } catch {
    return false;
  }
}

/** True when `signatureBase64` is the wallet's Ed25519 signature over the UTF-8 message. */
export function verifyWalletSignature(wallet: string, message: string, signatureBase64: string): boolean {
  try {
    const raw = new PublicKey(wallet).toBytes();
    const signature = Buffer.from(signatureBase64, "base64");
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]),
      format: "der",
      type: "spki",
    });
    return verifySignature(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/** Mainnet RPC for the balance check. The web app's NEXT_PUBLIC_RPC_URL may point at devnet, so it is not used. */
export function gateRpcUrl(): string {
  const explicit = process.env.UPDOWN_GATE_RPC_URL?.trim();
  if (explicit) return explicit;
  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;
  return "https://api.mainnet-beta.solana.com";
}

interface TokenAccountsResponse {
  result?: { value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } }[] };
  error?: { message?: string };
}

/** Whole CATO held by `wallet` across all of its token accounts for the mint. */
export async function fetchCatoBalance(
  wallet: string,
  rpcUrl: string = gateRpcUrl(),
  mint: string = CATO_MINT,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }],
    }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const data = (await res.json()) as TokenAccountsResponse;
  if (data.error) throw new Error(data.error.message || "RPC error");
  return (data.result?.value ?? []).reduce(
    (sum, entry) => sum + (entry.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
    0,
  );
}
