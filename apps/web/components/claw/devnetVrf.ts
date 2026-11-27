import { resolvePull, type LockedPull, type PullResult } from "./rewards";

type Phantom = { isPhantom: boolean; publicKey: { toBase58(): string } | null;
  connect(): Promise<unknown>; signMessage(message: Uint8Array, display?: "utf8"): Promise<{ signature: Uint8Array }>;
  signTransaction?(transaction: import("@solana/web3.js").VersionedTransaction): Promise<import("@solana/web3.js").VersionedTransaction> };
declare global { interface Window { phantom?: { solana?: Phantom } } }
export type GameReceipt = { gameId: string; pending: boolean; submitted: boolean; notFound?: boolean;
  result: PullResult | null; pull: LockedPull; requestSignature: string | null; callbackSignature: string | null; sponsorError?: string | null;
  timings: { preparationStartedAt?: number; lockedAt: number; submittedAt: number | null; confirmedAt: number | null; callbackVerifiedAt: number | null;
    requestedSlot: string | null; fulfilledSlot: string | null } };
type Plan = Partial<GameReceipt> & { id?: string; sponsored?: boolean };
export type VrfTimingEvent = { pullId: string; phase: string; at: number; receipt?: GameReceipt };
export type DevnetAvailability = { authority: string; cluster: string; execution: string; deployed: boolean;
  sponsor: { ready: boolean; remaining: number; expiresAt: number | null } };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function createDevnetVrf(onTiming: (event: VrfTimingEvent) => void, execution: "base" | "er" = "base", allowReadOnly = false) {
  let authority = "", wallet: Phantom | undefined;
  const inflight = new Map<string, { snapshot: string; promise: Promise<PullResult> }>();
  const token = () => {
    const port = execution === "er" ? "4322" : "4321";
    if (location.hostname !== "127.0.0.1" || location.port !== port) throw Error(`Open this test through the local devnet signer on port ${port}.`);
    const value = new URLSearchParams(location.hash.slice(1)).get("session");
    if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw Error("Open the test link from the local signer, including its session fragment.");
    return value!;
  };
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/${path}`, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token()}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok) throw Error(data.error ?? "local_request_failed");
    return data as T;
  }
  const emit = (pullId: string, phase: string, receipt?: GameReceipt) => onTiming({ pullId, phase, at: Date.now(), receipt });
  function verifiedResult(pull: LockedPull, receipt: GameReceipt) {
    if (!receipt.result || !receipt.callbackSignature || receipt.gameId !== pull.id) throw Error("Verified VRF result does not match this locked pull.");
    const expected = resolvePull(pull, () => receipt.result!.roll!, "magicblock-vrf");
    if (JSON.stringify(expected) !== JSON.stringify(receipt.result)) throw Error("Verified VRF result does not match this locked pull.");
    emit(pull.id, "result-ready", receipt); return expected;
  }
  async function run(pull: LockedPull) {
    if (!wallet?.isPhantom || wallet.publicKey?.toBase58() !== authority) throw Error("Connect the required Phantom wallet first.");
    emit(pull.id, "started");
    if (!pull.target) { const result = resolvePull(pull, () => { throw Error("No random draw for an empty target"); }, "magicblock-vrf"); emit(pull.id, "no-target"); return result; }
    const plan = await api<Plan>("game/plan", { pull });
    if (plan.result) return verifiedResult(pull, plan as GameReceipt);
    if (plan.id) throw Error("This server still requires per-drop signing. Complete the sponsored devnet setup first.");
    emit(pull.id, "sponsored");
    let confirmed = !!plan.timings?.confirmedAt;
    if (confirmed) emit(pull.id, "request-confirmed");
    while (true) {
      let receipt: GameReceipt;
      try { receipt = await api<GameReceipt>(`game/result?id=${encodeURIComponent(pull.id)}`); }
      catch { emit(pull.id, "rpc-retry"); await pause(1200); continue; }
      if (!confirmed && receipt.timings?.confirmedAt) { confirmed = true; emit(pull.id, "request-confirmed", receipt); }
      if (receipt.result) {
        return verifiedResult(pull, receipt);
      }
      if (receipt.sponsorError && !receipt.submitted) throw Error(`Sponsor paused: ${receipt.sponsorError}. Resume the same locked attempt after admin setup.`);
      emit(pull.id, "callback-pending", receipt);
      await pause(250);
    }
  }
  return {
    async connect() {
      token();
      const state = await api<DevnetAvailability>("game/availability");
      if (state.execution !== execution) throw Error("The test execution path does not match the local server.");
      if (state.cluster !== "devnet" || !state.deployed) throw Error("The verified devnet program must be deployed first.");
      if (!state.sponsor?.ready && !allowReadOnly) throw Error("The sponsor is not active. Complete sponsor setup on the localhost signing page first.");
      wallet = window.phantom?.solana;
      if (!wallet?.isPhantom) throw Error("Open this page in the browser with your Phantom extension.");
      await wallet.connect(); authority = state.authority;
      if (wallet.publicKey?.toBase58() !== authority) throw Error(`Select the devnet test wallet ${authority}.`);
      return authority;
    },
    latest: () => api<GameReceipt>("game/result"),
    availability: () => api<DevnetAvailability>("game/availability"),
    recordTiming: (id: string, events: Record<string, number>) => api("game/timing", { id, events }),
    resolve(pull: LockedPull) {
      const snapshot = JSON.stringify(pull), prior = inflight.get(pull.id);
      if (prior) { if (prior.snapshot !== snapshot) return Promise.reject(Error("Attempt inputs changed.")); return prior.promise; }
      const promise = run(pull).catch(error => { inflight.delete(pull.id); throw error; });
      inflight.set(pull.id, { snapshot, promise }); return promise;
    },
  };
}
