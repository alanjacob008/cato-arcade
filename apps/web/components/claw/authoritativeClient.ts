import type { LockedPull, PrizeBox, PullResult, Aim } from "./rewards";
import type { DailyArrangement } from "./daily";
import type { DevnetAvailability } from "./devnetVrf";
import type { TokenTier } from "./tokens";
import type { PlayerWallet } from "./playerWallet";

export type PlayerState = { namespace: "devnet-test-v1" | "devnet-test-pg-v1" | "devnet-usdc-v1"; wallet: string; revision: number; arrangement: DailyArrangement;
  initialBoxes: PrizeBox[]; boxes: PrizeBox[]; balances: [number, number, number]; winningsCents: number; sessionWinningsCents: number;
  withdrawableCents: number; paymentsEnabled: boolean; sessionWithdrawableCents?: number; pendingWithdrawal?: {id: string; cents: number; status: string} | null;
  pending: { id: string; pull: LockedPull; error: string | null } | null;
  history: { id: string; tier: TokenTier; entryCents: number; result: PullResult; requestSignature: string | null; callbackSignature: string | null }[] };
export type PlayIntent = { requestId: string; revision: number; aim: Aim; tier: number };
type Receipt = { id: string; pull: LockedPull; result: PullResult | null; state: PlayerState };
const AUTH_KEY = "cato-authoritative-devnet-auth-v1", INTENT_KEY = "cato-authoritative-devnet-intent-v1";
const CREDIT_KEY = "cato-authoritative-devnet-credit-v1";
const PURCHASE_KEY = "cato-devnet-usdc-purchase-v1", WITHDRAW_KEY="cato-devnet-usdc-withdraw-v1";
type Payment = {id:string;status:string;cents:number;signature:string|null};
type PaymentReceipt = {payment:Payment;state:PlayerState};
export const GAME_UNAVAILABLE = "The game is unavailable right now. Try again in a minute.";
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
export function createAuthoritativeClient(playerWallet: PlayerWallet) {
  let token = "", wallet = "", namespace = "";
  async function api<T>(route: string, body?: unknown): Promise<T> {
    // Network failures, timeouts and non-JSON replies (e.g. a host error page during a redeploy) all mean the
    // backend is unreachable right now; backend errors with a code are passed through for callers to branch on.
    const retryableRead = body === undefined && (route === "availability" || route === "state");
    const deadline = Date.now() + 8000;
    for (let attempt = 0; ; attempt++) {
      let response: Response, result: { error?: string; state?: { namespace?: unknown }; namespace?: unknown };
      try {
        const timeout = retryableRead ? Math.min(4000, deadline - Date.now()) : 20000;
        if (timeout <= 0) throw Error(GAME_UNAVAILABLE);
        response = await fetch(`/api/player/${route}`, { method: body === undefined ? "GET" : "POST", cache: "no-store", signal: AbortSignal.timeout(timeout),
          headers: { ...(token ? { "X-Cato-Player-Session": token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        result = await response.json();
      } catch {
        if (retryableRead && attempt === 0) { await pause(); continue; }
        throw Error(GAME_UNAVAILABLE);
      }
      if (!response.ok && (result.error === "preview_service_unavailable" || result.error === "claw_service_busy_retry" || response.status >= 500 && !result.error)) {
        if (retryableRead && attempt === 0) { await pause(); continue; }
        throw Error(GAME_UNAVAILABLE);
      }
      if (!response.ok) throw Error(result.error ?? (response.status >= 500 ? GAME_UNAVAILABLE : "player_request_failed"));
      const state=result.state??result;if(typeof state.namespace==="string")namespace=state.namespace;return result as T;
    }
  }
  // Best effort: the backend revokes only this session. Balances and any pending attempt stay with the wallet.
  function revoke(stale: string) {
    if (!/^[a-f0-9]{64}$/.test(stale)) return;
    void fetch("/api/player/logout", { method: "POST", cache: "no-store", signal: AbortSignal.timeout(5000),
      headers: { "X-Cato-Player-Session": stale, "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }
  const verifyWallet = () => { if (!wallet || playerWallet.address() !== wallet) throw Error("Reconnect your wallet before playing."); };
  async function waitPayment(kind: "purchase"|"withdrawal",id:string):Promise<PaymentReceipt>{
    const deadline=Date.now()+120000;
    while(Date.now()<deadline){verifyWallet();const receipt=await api<PaymentReceipt>(`${kind}?id=${encodeURIComponent(id)}`);
      if(["credited","paid"].includes(receipt.payment.status))return receipt;
      if(receipt.payment.status==="failed"){
        if(kind==="withdrawal"){try{const saved=JSON.parse(sessionStorage.getItem(WITHDRAW_KEY)??"null");if(saved?.wallet===wallet&&saved.namespace===namespace&&saved.id===id)sessionStorage.removeItem(WITHDRAW_KEY);}catch{/* The server remains authoritative. */}}
        throw Error("Withdrawal failed onchain. Your available winnings have been restored.");
      }
      await new Promise(resolve=>setTimeout(resolve,1000));
    }throw Error("Payment is still pending. Reopen this action to resume the same request.");
  }
  return {
    async connect() {
      wallet = await playerWallet.connect();
      const saved = sessionStorage.getItem(AUTH_KEY); if (saved) {
        try {
          const auth = JSON.parse(saved);
          if (auth.wallet === wallet) { token = auth.token; return await api<PlayerState>("state"); }
          // A token is never reused for another wallet: revoke the other wallet's session.
          sessionStorage.removeItem(AUTH_KEY); revoke(String(auth.token));
        } catch { /* Request a new single-use proof after expiry. */ }
      }
      token = "";
      const challenge = await api<{ id: string; message: string; expires: number }>("challenge", { wallet });
      const signed = await playerWallet.signMessage(new TextEncoder().encode(challenge.message));
      const signature = Array.from(signed, byte => byte.toString(16).padStart(2, "0")).join("");
      const auth = await api<{ token: string; state: PlayerState }>("login", { id: challenge.id, wallet, signature });
      token = auth.token; sessionStorage.setItem(AUTH_KEY, JSON.stringify({ wallet, token })); return auth.state;
    },
    /** Signs this tab out: forgets the stored token and revokes it on the backend. */
    signOut() {
      const stale = token; token = ""; wallet = "";
      try { sessionStorage.removeItem(AUTH_KEY); } catch { /* Storage unavailable. */ }
      revoke(stale);
    },
    state: () => api<PlayerState>("state"),
    availability: () => api<DevnetAvailability>("availability"),
    queued(): PlayIntent | null { try { const saved = JSON.parse(sessionStorage.getItem(INTENT_KEY) ?? "null"); return saved?.wallet === wallet && saved.namespace===namespace ? saved.intent : null; } catch { return null; } },
    async begin(intent: PlayIntent) {
      verifyWallet(); sessionStorage.setItem(INTENT_KEY, JSON.stringify({ wallet, namespace, intent }));
      try { const receipt = await api<{ id: string; pull: LockedPull; state: PlayerState }>("play", intent); sessionStorage.removeItem(INTENT_KEY); return receipt; }
      catch (error) { if (error instanceof Error && ["stale_player_state", "insufficient_tokens", "machine_empty", "sponsor_setup_required", "player_attempt_pending"].includes(error.message)) sessionStorage.removeItem(INTENT_KEY); throw error; }
    },
    async resolve(id: string, resume = false): Promise<Receipt> {
      verifyWallet(); if (resume) await api<Receipt>("resume", { id });
      for (;;) {
        let receipt: Receipt;
        try { receipt = await api<Receipt>(`result?id=${encodeURIComponent(id)}`); }
        catch (error) { if (error instanceof Error && ["player_authentication_required", "attempt_not_found"].includes(error.message)) throw error; await pause(); continue; }
        if (receipt.result) return receipt;
        if (receipt.state.pending?.error && !["vrf_pool_busy_retry_same_attempt", "er_pool_session_pending_or_missing", "previous_callback_pending_check_status"].includes(receipt.state.pending.error)) throw Error(receipt.state.pending.error);
        await pause();
      }
    },
    async addTokens(tier: number, quantity: number) {
      verifyWallet(); let request = { requestId: crypto.randomUUID(), tier, quantity };
      try { const saved = JSON.parse(sessionStorage.getItem(CREDIT_KEY) ?? "null"); if (saved?.wallet === wallet && saved.request.tier === tier && saved.request.quantity === quantity) request = saved.request; } catch { /* New bounded test-credit request. */ }
      sessionStorage.setItem(CREDIT_KEY, JSON.stringify({ wallet, request }));
      try { const state = await api<PlayerState>("test-credit", request); sessionStorage.removeItem(CREDIT_KEY); return state; }
      catch (error) { if (error instanceof Error && ["invalid_test_credit", "daily_test_credit_limit_reached", "player_attempt_pending"].includes(error.message)) sessionStorage.removeItem(CREDIT_KEY); throw error; }
    },
    async purchase(tier:number,quantity:number){
      verifyWallet();let request={requestId:crypto.randomUUID(),tier,quantity};
      try{const saved=JSON.parse(sessionStorage.getItem(PURCHASE_KEY)??"null");if(saved?.wallet===wallet&&saved.namespace===namespace&&saved.request.tier===tier&&saved.request.quantity===quantity)request=saved.request;}catch{/* New user purchase. */}
      sessionStorage.setItem(PURCHASE_KEY,JSON.stringify({wallet,namespace,request}));
      const plan=await api<{id:string;transaction?:string;status:string;state?:PlayerState}>("purchase-plan",request);
      if(plan.state&&plan.status==="credited"){sessionStorage.removeItem(PURCHASE_KEY);return plan.state;}
      if(plan.transaction){
        verifyWallet();const signed=await playerWallet.signTransaction(plan.transaction);
        verifyWallet();await api("purchase-submit",{id:plan.id,signedTransaction:signed});
      }
      const receipt=await waitPayment("purchase",plan.id);sessionStorage.removeItem(PURCHASE_KEY);return receipt.state;
    },
    async withdraw(scope:"session"|"all",pendingId?:string){
      verifyWallet();let request={requestId:crypto.randomUUID(),scope};
      try{const saved=JSON.parse(sessionStorage.getItem(WITHDRAW_KEY)??"null");if(saved?.wallet===wallet&&saved.namespace===namespace&&saved.request.scope===scope)request=saved.request;}catch{/* New withdrawal intent. */}
      sessionStorage.setItem(WITHDRAW_KEY,JSON.stringify({wallet,namespace,request}));
      const first=pendingId?null:await api<PaymentReceipt>("withdraw",request),id=pendingId??first!.payment.id;
      sessionStorage.setItem(WITHDRAW_KEY,JSON.stringify({wallet,namespace,request,id}));
      const receipt=await waitPayment("withdrawal",id);sessionStorage.removeItem(WITHDRAW_KEY);return receipt;
    },
  };
}
