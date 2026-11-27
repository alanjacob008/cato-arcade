import type { GateResult, RevealPayload, ShareData } from "@cato/shared";
import { demoGate, demoReveal, demoShare } from "./demoData";

/** Base URL of the CATO Wrapped API (Heroku in prod, localhost in dev). */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

/** Demo mode feeds sample data so the UI is viewable without the backend. */
const DEMO = process.env.NEXT_PUBLIC_DEMO === "1";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

/** The gate response also carries the resolved owner wallet (for .sol domains). */
export type GateResponse = GateResult & { wallet?: string };

export const fetchGate = (wallet: string): Promise<GateResponse> =>
  DEMO ? Promise.resolve(demoGate(wallet)) : getJson(`/gate?wallet=${encodeURIComponent(wallet)}`);

export const fetchReveal = (wallet: string, demoVariant?: string): Promise<RevealPayload> =>
  DEMO ? Promise.resolve(demoReveal(wallet, demoVariant)) : getJson(`/reveal?wallet=${encodeURIComponent(wallet)}`);

export const fetchShare = (wallet: string): Promise<ShareData> =>
  DEMO ? Promise.resolve(demoShare(wallet)) : getJson(`/share/${encodeURIComponent(wallet)}`);

/** A swap done through our frontend, recorded to the backend (best-effort, never throws). */
export interface SwapRecord {
  txid: string;
  wallet?: string | null;
  inputMint?: string;
  outputMint?: string;
  inAmount?: string;
  outAmount?: string;
  feeBps?: number;
  referralAccount?: string | null;
  raw?: unknown;
}

export async function recordSwap(rec: SwapRecord): Promise<void> {
  if (DEMO) return;
  try {
    await fetch(`${API_BASE}/swaps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rec),
    });
  } catch {
    // Recording is best-effort — never let a logging failure surface to the user.
  }
}

export async function getStakersCount(): Promise<number> {
  try{
    const response = await fetch(`${API_BASE}/staking/staker-count`);
    if(!response || !response.ok) return 0;
    const data = await response.json() as { count: number};
    return data.count;
  } catch(e){
    console.log('Error while fetching stakers count', e);
    return 0;
  }
}
