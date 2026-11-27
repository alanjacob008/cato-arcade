"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { createAuthoritativeClient, GAME_UNAVAILABLE, type PlayerState } from "./authoritativeClient";
import { signedInWalletLost, waitForWalletConnection, type PlayerWallet } from "./playerWallet";
import { createMachine, type MachineController } from "./createMachine";
import { createPhysicsService } from "./physicsService";
import { dailyArrangement } from "./daily";
import { loadMachineFont } from "./machineTypography";
import { loadPrizeLogo } from "./prizeModel";
import { loadPavementTexture } from "./pavementScene";
import { EMPTY_LOADING, completeLoadingTask, loadingProgress, resetMachineLoading, type LoadingTask } from "./loadingProgress";
import { useArcadeAudio } from "./useArcadeAudio";
import type { DevnetAvailability } from "./devnetVrf";
import type { PullResult } from "./rewards";
import { outcomeCue } from "./feedback";
import { revealWalletLights } from "./walletEntrance";
import { pollConnection } from "./connectionPolling";
import PlayerArcade from "./PlayerArcade";
import ArcadeLoading, { useLoadingPayoff } from "./ArcadeLoading";
import type { DrawProgress } from "./FairDraw";
import DevnetWithdrawalDialog from "./DevnetWithdrawalDialog";
import styles from "./devnet.module.css";


/** Adapts the site wallet picker (Phantom, Solflare, Coinbase) to the claw player client. */
function useSitePlayerWallet(): PlayerWallet {
  const adapter = useWallet(), modal = useWalletModal(), latest = useRef({ adapter, modal });
  latest.current = { adapter, modal };
  return useMemo<PlayerWallet>(() => ({
    address: () => latest.current.adapter.publicKey?.toBase58() ?? null,
    connect: () => waitForWalletConnection({
      read: () => {
        const { adapter: current, modal: picker } = latest.current;
        return { address: current.publicKey?.toBase58() ?? null, pickerOpen: picker.visible, connecting: current.connecting, selected: !!current.wallet };
      },
      openPicker: () => latest.current.modal.setVisible(true),
      closePicker: () => latest.current.modal.setVisible(false),
      connectSelected: () => latest.current.adapter.connect(),
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: Date.now,
    }),
    async signMessage(message) {
      const sign = latest.current.adapter.signMessage;
      if (!sign) throw Error("wallet_cannot_sign_messages");
      return sign(message);
    },
    async signTransaction(base64) {
      const sign = latest.current.adapter.signTransaction;
      if (!sign) throw Error("wallet_cannot_sign_transactions");
      const { VersionedTransaction } = await import("@solana/web3.js");
      const signed = await sign(VersionedTransaction.deserialize(Uint8Array.from(atob(base64), char => char.charCodeAt(0))));
      return btoa(String.fromCharCode(...signed.serialize()));
    },
  }), []);
}

export default function AuthoritativeArcade() {
  const playerWallet = useSitePlayerWallet();
  const [view, setView] = useState<PlayerState | null>(null), [setup, setSetup] = useState<PlayerState | null>(null);
  const [machineReady, setReady] = useState(false), [busy, setBusy] = useState(false), [connecting, setConnecting] = useState(false);
  const [renderError, setRenderError] = useState(false);
  // Only a failed scene setup (not a failed availability poll, which the HUD reports) turns the loading screen into an error.
  const [setupFailed, setSetupFailed] = useState(false);
  // The machine is ready; the loading screen shows its full sign for one beat, then lifts and the arcade is ready.
  const ready = useLoadingPayoff(machineReady && !renderError);
  const enteringRef = useRef(false);
  const [error, setError] = useState(""), [tier, setTier] = useState(0), [top, setTop] = useState(false), [clock, setClock] = useState(0);
  const [availability, setAvailability] = useState<DevnetAvailability | null>(null), [checking, setChecking] = useState(false), [unavailable, setUnavailable] = useState(false);
  const [result, setResult] = useState<PullResult | null>(null), [queued, setQueued] = useState(false);
  const [withdrawOpen,setWithdrawOpen]=useState(false);
  // Display only: when the current attempt's verified result reached this browser, for the deck's fair-draw strip.
  const [draw, setDraw] = useState<DrawProgress | null>(null);
  const [tasks, setTasks] = useState(EMPTY_LOADING), loading = loadingProgress(tasks);
  const markLoaded = useCallback((task: LoadingTask) => setTasks(previous => completeLoadingTask(previous, task)), []);
  const host = useRef<HTMLDivElement>(null), machine = useRef<MachineController | null>(null), model = useRef<PlayerState | null>(null);
  const api = useRef<ReturnType<typeof createAuthoritativeClient> | null>(null), blocked = useRef(false), alive = useRef(true), refreshing = useRef(false);
  const pendingResult = useRef<Promise<Awaited<ReturnType<ReturnType<typeof createAuthoritativeClient>["resolve"]>>> | null>(null);
  const dropAction = useRef<() => void>(() => {});
  const { playCue, motion, stop: stopAudio, activate: activateAudio, ...audio } = useArcadeAudio();
  const client = useCallback(() => api.current ??= createAuthoritativeClient(playerWallet), [playerWallet]);
  const apply = useCallback((state: PlayerState) => {
    if (!alive.current) return;
    const changed = model.current?.wallet !== state.wallet || model.current?.arrangement.id !== state.arrangement.id;
    model.current = state; setView(state);
    // Adopt wallet-specific poses/colors in the preloaded scene instead of rebuilding it.
    const reused = changed && machine.current?.replaceArrangement(state.initialBoxes, state.boxes, state.arrangement);
    if (changed && !reused) { setReady(false); setTasks(previous => resetMachineLoading(previous)); markLoaded("pile"); setSetup(state); }
    else if (!changed) machine.current?.applyAuthoritativeBoxes(state.boxes);
    setQueued(!!client().queued());
  }, [client, markLoaded]);
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    setChecking(true);
    try {
      const next = await client().availability(); if (!alive.current) return;
      setAvailability(next);
      if (model.current?.wallet && !blocked.current) { const state = await client().state(); if (!alive.current) return; apply(state); }
      setUnavailable(false); setError(previous => previous === GAME_UNAVAILABLE ? "" : previous);
    }
    catch (value) {
      if (!alive.current) return;
      // Drop stale availability so play is not left enabled while the backend is unreachable.
      if (value instanceof Error && value.message === GAME_UNAVAILABLE) { setAvailability(null); setUnavailable(true); }
      setError(value instanceof Error ? value.message : "Unable to refresh player state.");
    }
    finally { refreshing.current = false; if (alive.current) setChecking(false); }
  }, [apply, client]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Account switched or wallet disconnected after sign-in: drop the old sign-in (play is already refused for it)
  // so the player can connect again without reloading. Waits until any draw in flight has finished.
  // The old session token is forgotten and revoked; the wallet's pending attempt is recovered after signing in again.
  const currentAddress = useWallet().publicKey?.toBase58() ?? null;
  useEffect(() => {
    const signed = model.current?.wallet ?? "";
    if (busy || blocked.current || !signedInWalletLost(signed, currentAddress)) return;
    api.current?.signOut(); api.current = null;
    const signedOut = { ...model.current!, wallet: "" };
    model.current = signedOut; setView(signedOut);
    setError("Your wallet changed. Connect again to keep playing.");
  }, [currentAddress, busy]);
  useEffect(() => {
    const physics = createPhysicsService(); let cancelled = false;
    void (async () => {
      const arrangement = dailyArrangement("authoritative-preview", Date.now());
      const [boxes] = await Promise.all([
        physics.create(arrangement.seed).then(boxes => { markLoaded("pile"); return boxes; }),
        loadMachineFont().then(() => markLoaded("font")), loadPrizeLogo().then(() => markLoaded("logo")), loadPavementTexture(markLoaded),
      ]);
      if (cancelled || model.current?.wallet) return;
      const preview: PlayerState = { namespace: "devnet-test-v1", wallet: "", revision: 0, arrangement, initialBoxes: boxes, boxes,
        balances: [0, 0, 0], winningsCents: 0, sessionWinningsCents: 0, withdrawableCents: 0, paymentsEnabled: false, pending: null, history: [] };
      model.current = preview; setView(preview); setSetup(preview);
    })().catch(() => { if (!cancelled) { setSetupFailed(true); setError("Unable to load the machine. Refresh to retry."); } });
    return () => { cancelled = true; physics.dispose(); };
  }, [markLoaded]);
  useEffect(() => pollConnection(refresh, () => !blocked.current), [refresh]);
  useEffect(() => { const tick = () => setClock(Date.now()); const initial = setTimeout(tick, 0), timer = setInterval(tick, 1000); return () => { clearTimeout(initial); clearInterval(timer); }; }, []);
  async function finish(outcome: PullResult) {
    try {
      const receipt = await pendingResult.current;
      if (!receipt?.result || receipt.result.pullId !== outcome.pullId) throw Error("Verified result unavailable. Resume the attempt.");
      if (!alive.current) return;
      apply(receipt.state); blocked.current = false; setBusy(false); setResult(receipt.result); pendingResult.current = null;
      motion(0, "hoist"); playCue(outcomeCue(outcome.success, outcome.cents)); void refresh();
    } catch (value) { fail(value); }
  }
  function fail(value: unknown) {
    stopAudio();
    if (!alive.current) return;
    blocked.current = false; setBusy(false); setError(value instanceof Error ? value.message.replaceAll("_", " ") : "Attempt paused. Resume it to recover.");
    void client().state().then(apply).catch(() => {}); setQueued(!!client().queued());
  }
  const finishRef = useRef(finish), failRef = useRef(fail);
  useEffect(() => { finishRef.current = finish; failRef.current = fail; });
  useEffect(() => {
    if (!setup || !host.current) return;
    setRenderError(false);
    const physics = createPhysicsService(); let disposed = false;
    const controller = createMachine(host.current, { initialBoxes: setup.initialBoxes, boxes: setup.boxes, arrangement: setup.arrangement, pickup: physics.pickup, plan: physics.plan },
      () => {}, phase => { if (phase === "grabbing") playCue("grab"); },
      outcome => void finishRef.current(outcome), async pull => {
        const receipt = await pendingResult.current; if (!receipt?.result || receipt.id !== pull.id) throw Error("Attempt recovery required."); return receipt.result;
      }, value => failRef.current(value), () => {}, () => playCue("impact"), motion);
    machine.current = controller; controller.setTheme("violet");
    queueMicrotask(() => { if (!disposed) markLoaded("scene"); });
    controller.setConfig(tier, {}, false, "USDC"); controller.setView(top ? "top" : "front"); controller.setConnected(false);
    void controller.ready.then(() => { if (!disposed) { markLoaded("ready"); setReady(true); } }).catch(value => { if (!disposed) { setRenderError(true); failRef.current(value); } });
    const held = new Set<string>();
    const move = () => controller.move(Number(held.has("d") || held.has("arrowright")) - Number(held.has("a") || held.has("arrowleft")), Number(held.has("s") || held.has("arrowdown")) - Number(held.has("w") || held.has("arrowup")));
    const stop = () => { held.clear(); controller.move(0, 0); };
    const down = (event: KeyboardEvent) => {
      if (enteringRef.current || blocked.current || model.current?.pending || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLElement && event.target.closest("button,input,a,dialog")) return;
      const key = event.key.toLowerCase(); if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) { event.preventDefault(); activateAudio(); held.add(key); move(); }
      if (event.code === "Space" && !event.repeat) { event.preventDefault(); dropAction.current(); }
    };
    const up = (event: KeyboardEvent) => { held.delete(event.key.toLowerCase()); if (!blocked.current) move(); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", stop);
    return () => { disposed = true; controller.dispose(); physics.dispose(); machine.current = null; window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", stop); };
  }, [setup, playCue, motion, activateAudio, markLoaded]);
  useEffect(() => {
    const controller = machine.current; if (!controller) return;
    controller.setConnected(false);
    if (!ready || connecting || renderError || !view?.wallet || currentAddress !== view.wallet) return;
    return revealWalletLights(() => { if (machine.current === controller) controller.setConnected(true); });
  }, [currentAddress, view?.wallet, ready, connecting, renderError, setup]);
  useEffect(() => { machine.current?.setConfig(tier, {}, false, "USDC"); machine.current?.setView(top ? "top" : "front"); }, [tier, top, ready]);
  async function connect() {
    if (!ready || connecting || renderError) return;
    setConnecting(true); setError(""); machine.current?.setConnected(false);
    try { const state = await client().connect(); apply(state); void refresh(); }
    catch (value) { fail(value); } finally { setConnecting(false); }
  }
  async function drop() {
    const current = model.current, controller = machine.current;
    if (enteringRef.current || !current?.wallet || !controller || !ready || blocked.current || current.pending || !current.balances[tier]) return;
    blocked.current = true; setBusy(true); setError(""); setResult(null); setDraw(null); controller.move(0, 0); activateAudio(); playCue("press");
    const pressedAt = performance.now();
    try {
      const prepared = await client().begin({ requestId: crypto.randomUUID(), revision: current.revision, aim: controller.getAim(), tier });
      if (!alive.current) return;
      // Only the signed-in backend chooses this target, its odds and price.
      model.current = prepared.state; setView(prepared.state); setQueued(false);
      // Display only: with no box under the claw the backend settles at once and requests no VRF, so the strip never claims one.
      const noTarget = prepared.pull.target === null;
      setDraw({ id: prepared.id, deliveredMs: null, noTarget });
      const pull = controller.prepareDrop(prepared.id, tier, "USDC", {}, prepared.pull); if (!pull) throw Error("Attempt reserved. Resume to recover.");
      pendingResult.current = client().resolve(prepared.id); void pendingResult.current.catch(() => {});
      if (!noTarget) void pendingResult.current.then(receipt => { if (alive.current && receipt.result) setDraw({ id: prepared.id, deliveredMs: performance.now() - pressedAt }); }, () => {});
      await controller.insertToken(tier, true); playCue("insert");
    } catch (value) { fail(value); }
  }
  useEffect(() => { dropAction.current = () => void drop(); });
  async function recover() {
    if (blocked.current) return; blocked.current = true; setBusy(true); setError(""); setDraw(null);
    try {
      const queuedIntent = client().queued();
      let state = await client().state(), id = state.pending?.id;
      if (queuedIntent) { const receipt = await client().begin(queuedIntent); state = receipt.state; id = receipt.id; }
      if (!id) { apply(state); blocked.current = false; setBusy(false); return; }
      pendingResult.current = client().resolve(id, true); const receipt = await pendingResult.current;
      if (!receipt.result) throw Error("Attempt still pending."); await finish(receipt.result);
    } catch (value) { fail(value); }
  }
  const entering = !ready && !renderError;
  enteringRef.current = entering || connecting;
  if (!view) return <div className={styles.lab}><ArcadeLoading progress={loading.percent} label={loading.label} failed={setupFailed || renderError} /></div>;
  const active = !!availability?.deployed && !!availability.sponsor.ready
    && (availability.sponsor.expiresAt === null || availability.sponsor.expiresAt > clock / 1000);
  return <><PlayerArcade host={host} daily={view.arrangement} now={clock} tier={tier} ready={ready} busy={busy} renderError={renderError} topView={top}
    entering={entering}
    empty={!view.boxes.length} persistent loading={loading} phase={busy ? "playing" : "ready"} result={result} history={view.history.map(item => item.result)}
    sessionWinningsCents={view.sessionWinningsCents} totalWinningsCents={view.winningsCents} availableWinningsCents={view.withdrawableCents} sessionWithdrawableCents={view.sessionWithdrawableCents??0} onWithdraw={() => 0}
    tokenBalances={view.balances} theme="violet" progress={{ plays: view.history.length, catches: view.history.filter(item => item.result.success).length, rareCatches: view.history.filter(item => item.result.cents >= 1000).length }}
    receipts={view.history.map(item => ({ id: item.id, tier: item.tier, entryCents: item.entryCents, prizeCents: item.result.cents, netCents: item.result.cents - item.entryCents,
      vrf: { targetId: item.result.targetId, source: item.result.source, requestSignature: item.requestSignature, callbackSignature: item.callbackSignature } }))}
    soundMuted={audio.muted} onSound={audio.toggleMuted} onActivateAudio={activateAudio} onBuyTokens={async (selected, quantity) => { apply(view.paymentsEnabled?await client().purchase(selected,quantity):await client().addTokens(selected, quantity)); }}
    onTier={selected => { if (!blocked.current) setTier(selected); }} onView={() => setTop(value => !value)} onDrop={() => void drop()}
    onDragAim={(x, z) => { if (!blocked.current && !model.current?.pending) machine.current?.dragAim(x, z); }}
    testSession={{ wallet: view.wallet, connecting, onConnect: () => void connect(), pending: !!view.pending || queued, onResume: () => void recover(), active,
      remaining: availability?.sponsor.remaining ?? null, checking, error, unavailable, onRefresh: () => void refresh(),paymentsEnabled:view.paymentsEnabled,pendingWithdrawal:!!view.pendingWithdrawal,onWithdraw:()=>setWithdrawOpen(true),
      execution: availability?.execution === "er" ? "er" : availability?.execution === "base" ? "base" : undefined, draw }} />
    {withdrawOpen&&view.paymentsEnabled&&<DevnetWithdrawalDialog available={view.withdrawableCents} session={view.sessionWithdrawableCents??0} pending={view.pendingWithdrawal} onClose={()=>setWithdrawOpen(false)}
      onWithdraw={async scope=>{try{const receipt=await client().withdraw(scope,model.current?.pendingWithdrawal?.id);apply(receipt.state);return {cents:receipt.payment.cents,signature:receipt.payment.signature};}catch(value){void refresh();throw value;}}} />}
  </>;
}
