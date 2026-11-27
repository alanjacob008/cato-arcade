"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HiOutlineArrowUpRight, HiOutlineSparkles, HiOutlineWallet, HiOutlineViewfinderCircle } from "react-icons/hi2";
import { createPhysicsService, type PhysicsService, type PhysicsMetric } from "./physicsService";
import { createMachine, type MachineController, type MachinePhase, type RenderMetrics } from "./createMachine";
import { ARENA, MACHINE, BET_TIERS, boxTop, upwardFaceGripFactor, exposedBoxes, parametersFor, selectTarget, entryPriceUsd, createPickupProvider, seededRandom, browserRandom, simulatePickups, type PrizeBox, type Aim, type Overrides, type GrabParameters, type PaymentCurrency, type PullResult, type PickupProvider, type Simulation } from "./rewards";
import { dailyArrangement, needsDailyReset, canRotateDaily, countdown, loadDemoPlayer, dailyStorageKey, restoreDailyPile, saveDailyPile, type DailyArrangement, type DemoStorage } from "./daily";
import styles from "./claw.module.css";
import PlayerArcade from "./PlayerArcade";
import ArcadeLoading, { useLoadingPayoff } from "./ArcadeLoading";
import playerStyles from "./player.module.css";
import { loadMachineFont } from "./machineTypography";
import { EMPTY_TOTALS, playerTotalsKey, restorePlayerTotals, serializePlayerTotals, type PlayerTotals } from "./playerStats";
import { INITIAL_AIM } from "./config";
import { TOKEN_TYPES, createTokenWallet, tokenWalletKey, restoreTokenWallet, serializeTokenWallet, buyDemoTokens, insertDemoToken, ejectDemoToken, settleDemoToken, availableWinningsCents, sessionWithdrawableCents, withdrawDemoWinnings, type WithdrawalScope, type TokenWallet, type TokenTier } from "./tokens";
import { useArcadeAudio } from "./useArcadeAudio";
import { outcomeCue } from "./feedback";
import { loadPrizeLogo } from "./prizeModel";
import { loadPavementTexture } from "./pavementScene";
import { clubProgress, clubReceipts, type ClubTheme } from "./clubCosmetics";
import { readInitialPileCache, saveInitialPileCache } from "./initialPileCache";
import { EMPTY_LOADING, completeLoadingTask, resetMachineLoading, loadingProgress, type LoadingTask } from "./loadingProgress";


type Phase = "ready" | MachinePhase | "revealed" | "error";
type DailySession = { arrangement: DailyArrangement; initialBoxes: PrizeBox[]; boxes: PrizeBox[] };
const DIRECTIONS = [{ key: "W", name: "back", dx: 0, dz: -1 }, { key: "A", name: "left", dx: -1, dz: 0 }, { key: "S", name: "forward", dx: 0, dz: 1 }, { key: "D", name: "right", dx: 1, dz: 0 }];
const PHASE_COPY: Record<Phase, string> = { ready: "Aim at a box. Its prize is fixed.", inserting: "Inserting your token…", descending: "Descending at your locked position…", grabbing: "Closing the grip…", waiting: "Grip closed. One random draw.", lifting: "Lifting the claw…", delivering: "Delivering the box…", revealed: "Attempt complete.", error: "Draw failed. No funds charged." };
const percent = (v: number, min: number, max: number) => (v - min) / (max - min) * 100;
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default function ClawArcade({ mode = "player" }: { mode?: "player" | "lab" }) {
  const isLab = mode === "lab";
  const [loadingState, setLoadingState] = useState(EMPTY_LOADING);
  const markLoaded = useCallback((task: LoadingTask) => setLoadingState(previous => completeLoadingTask(previous, task)), []);
  const loading = loadingProgress(loadingState);
  const audio = useArcadeAudio(), playCue = audio.playCue, activateAudio = audio.activate, motionAudio = audio.motion;
  const host = useRef<HTMLDivElement>(null), machine = useRef<MachineController | null>(null), busyRef = useRef(false);
  const session = useRef<DailySession | null>(null), storage = useRef<DemoStorage | null>(null), changingDay = useRef(true), refreshDay = useRef<() => void>(() => {});
  const [daily, setDaily] = useState<DailyArrangement | null>(null), [initialBoxes, setInitialBoxes] = useState<PrizeBox[]>([]), [now, setNow] = useState(0), [persistent, setPersistent] = useState(true);
  const provider = useRef<PickupProvider | null>(null);
  if (provider.current === null) { provider.current = isLab ? createPickupProvider(seededRandom(42)) : createPickupProvider(browserRandom, "browser-demo"); }
  const aimRandom = useRef(seededRandom((42 ^ 0xa5a5a5a5) >>> 0)), dropAction = useRef<() => void>(() => {});
  const aimRef = useRef<Aim>(INITIAL_AIM);
  const [aim, setAim] = useState<Aim>(INITIAL_AIM), [boxes, setBoxes] = useState<PrizeBox[]>([]);
  const [tier, setTier] = useState(0), currency: PaymentCurrency = "USDC";

  const [phase, setPhase] = useState<Phase>("ready"), [machineReady, setReady] = useState(false), [renderError, setRenderError] = useState(false), [topView, setTopView] = useState(false);
  const currentView = useRef(false);
  useEffect(() => { currentView.current = topView; machine.current?.setView(topView ? "top" : "front"); }, [topView]);
  const [fontsReady, setFontsReady] = useState(false), [fontError, setFontError] = useState(false);
  const [overrides, setOverrides] = useState<Overrides>({}), [debug, setDebug] = useState(false), [editId, setEditId] = useState("BOX-34");
  const engineConfig = useRef<{ tier: number; overrides: Overrides; debug: boolean; currency: PaymentCurrency }>({ tier: 0, overrides: {}, debug: false, currency: "USDC" });
  const [seedDraft, setSeedDraft] = useState("42"), [appliedSeed, setAppliedSeed] = useState(42), [randomMode, setRandomMode] = useState<"seeded" | "browser">("seeded");
  const [lastDraw, setLastDraw] = useState<PullResult | null>(null), [result, setResult] = useState<PullResult | null>(null), [history, setHistory] = useState<PullResult[]>([]);
  const [wonCents, setWonCents] = useState(0);
  const [withdrawalSessionId, setWithdrawalSessionId] = useState("");
  const [sessionPlayIds, setSessionPlayIds] = useState<readonly string[]>([]);
  const [totals, setTotals] = useState<PlayerTotals>(EMPTY_TOTALS);
  const totalsKey = useRef<string | null>(null);
  const [tokenWallet, setTokenWallet] = useState<TokenWallet>(() => createTokenWallet());
  const tokenWalletRef = useRef(tokenWallet), tokensKey = useRef<string | null>(null), alive = useRef(true);
  const theme: ClubTheme = "violet", themeRef = useRef<ClubTheme>("violet");
  const progress = useMemo(() => clubProgress(tokenWallet.used), [tokenWallet.used]);
  const receipts = useMemo(() => clubReceipts(tokenWallet.used), [tokenWallet.used]);
  useEffect(() => { themeRef.current = theme; machine.current?.setTheme(theme); }, [theme, phase]);
  const activePlay = useRef<string | null>(null);
  const recordedPlays = useRef(new Set<string>());
  const [testMode, setTestMode] = useState<"random" | "aligned">("random"), [samples, setSamples] = useState(1000), [simulation, setSimulation] = useState<Simulation | null>(null);
  // The machine is ready; the loading screen shows its full sign for one beat, then lifts and the arcade is ready.
  const ready = useLoadingPayoff(machineReady && !renderError && !fontError);
  // Only the first load keeps the full-screen loader up; a day rollover later rebuilds under the compact stage loader.
  const [everReady, setEverReady] = useState(false);
  if (ready && !everReady) setEverReady(true);
  const busy = !["ready", "revealed", "error"].includes(phase), price = entryPriceUsd(tier, currency);
  const selection = isLab ? selectTarget(aim, boxes, tier, overrides, currency) : null, editable = boxes.find((box) => box.id === editId) ?? initialBoxes.find((box) => box.id === editId);
  const xPercent = percent(aim.x, ARENA.minX, ARENA.maxX), zPercent = percent(aim.z, ARENA.minZ, ARENA.maxZ);
  const arrangementId = daily?.id;
  const physicsRef = useRef<PhysicsService | null>(null);
  const [renderMetrics, setRenderMetrics] = useState<RenderMetrics | null>(null);
  const [physicsMetric, setPhysicsMetric] = useState<PhysicsMetric | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const storeTokens = useCallback((next: TokenWallet) => {
    tokenWalletRef.current = next; setTokenWallet(next);
    try {
      if (storage.current && tokensKey.current) storage.current.setItem(tokensKey.current, serializeTokenWallet(next));
      if (storage.current && totalsKey.current) storage.current.setItem(totalsKey.current, serializePlayerTotals(next.totals));
    } catch { setPersistent(false); }
  }, []);
  const recordTokenSession = useCallback((id: string) => {
    const used = tokenWalletRef.current.used[id];
    if (!used || recordedPlays.current.has(id)) return;
    recordedPlays.current.add(id); setSessionPlayIds(ids => [...ids, id]); setTotals(tokenWalletRef.current.totals);
    setWonCents(total => total + used.prizeCents);
  }, []);
  const drop = useCallback(() => {
    if (!machine.current || busyRef.current || changingDay.current || !session.current) return;
    if (!isLab && session.current.boxes.length === 0) return;
    if (needsDailyReset(session.current.arrangement, Date.now())) { refreshDay.current(); return; }
    const token = tokenWalletRef.current.pending;
    if (!isLab && !token) return;
    const pull = machine.current.prepareDrop(isLab ? crypto.randomUUID() : token!.id, isLab ? tier : token!.tier, currency, overrides);
    if (!pull) return;
    if (machine.current.startDrop()) { activateAudio(); playCue("press"); activePlay.current = pull.id; busyRef.current = true; setResult(null); setLastDraw(null); setPhase("descending"); }
  }, [tier, currency, overrides, isLab, playCue, activateAudio]);
  const insertAndDrop = useCallback(() => {
    if (isLab || tokenWalletRef.current.pending) { drop(); return; }
    const controller = machine.current;
    if (!controller || busyRef.current || changingDay.current || !session.current || session.current.boxes.length === 0 || !tokenWalletRef.current.balances[tier]) return;
    if (needsDailyReset(session.current.arrangement, Date.now())) { refreshDay.current(); return; }
    const id = crypto.randomUUID(), nextWallet = insertDemoToken(tokenWalletRef.current, id, tier);
    const pull = controller.prepareDrop(id, tier, currency, overrides);
    if (!pull) return;
    storeTokens(nextWallet); activateAudio(); activePlay.current = id;
    busyRef.current = true; setResult(null); setLastDraw(null); setPhase("inserting");
    void controller.insertToken(tier, true).then(() => {
      if (alive.current) { playCue("insert"); }
    }).catch(error => {
      if (!alive.current) return;
      console.error(error); controller.cancelDrop();
      if (tokenWalletRef.current.pending?.id === id) storeTokens(ejectDemoToken(tokenWalletRef.current, id));
      controller.setPowered(false); controller.setTokenReady(false); busyRef.current = false; setPhase("error");
    });
  }, [isLab, drop, tier, currency, overrides, storeTokens, activateAudio, playCue]);
  useEffect(() => { dropAction.current = isLab ? drop : insertAndDrop; }, [drop, insertAndDrop, isLab]);
  useEffect(() => {
    let cancelled = false;
    const complete = (task: LoadingTask) => { if (!cancelled) markLoaded(task); };
    void Promise.all([loadMachineFont().then(() => complete("font")), loadPrizeLogo().then(() => complete("logo")), loadPavementTexture(complete)]).then(() => { if (!cancelled) setFontsReady(true); }).catch((error) => {
      console.error("Machine asset failed to load", error); if (!cancelled) setFontError(true);
    });
    return () => { cancelled = true; };
  }, [markLoaded]);
  useEffect(() => { engineConfig.current = { tier, overrides, debug: isLab && debug, currency }; machine.current?.setConfig(tier, overrides, isLab && debug, currency); }, [tier, overrides, debug, currency, isLab]);
  useEffect(() => {
    const physics = createPhysicsService(); physicsRef.current = physics;
    let cancelled = false, pendingDayId: string | null = null;
    let playerId: string, storageUnavailable = false;
    try {
      const local = window.localStorage, prefix = isLab ? "cato-internal-lab:" : "";
      storage.current = { getItem: (key) => local.getItem(prefix + key), setItem: (key, value) => local.setItem(prefix + key, value) };
      playerId = loadDemoPlayer(storage.current, () => crypto.randomUUID());
    }
    catch { storage.current = null; playerId = crypto.randomUUID(); storageUnavailable = true; }
    const summaryKey = playerTotalsKey(playerId);
    let restoredTotals = EMPTY_TOTALS;
    try { restoredTotals = restorePlayerTotals(storage.current?.getItem(summaryKey) ?? null); }
    catch { storageUnavailable = true; }
    totalsKey.current = summaryKey;
    tokensKey.current = tokenWalletKey(playerId);
    let restoredTokens = createTokenWallet(restoredTotals);
    try { if (!isLab) restoredTokens = restoreTokenWallet(storage.current?.getItem(tokensKey.current) ?? null, restoredTotals); }
    catch { storageUnavailable = true; }
    // A reload before the draw returns the unplayed reservation to the new one-click flow.
    if (!isLab && restoredTokens.pending) {
      restoredTokens = ejectDemoToken(restoredTokens, restoredTokens.pending.id);
      try { storage.current?.setItem(tokensKey.current, serializeTokenWallet(restoredTokens)); }
      catch { storageUnavailable = true; }
    }
    tokenWalletRef.current = restoredTokens;
    if (!isLab) restoredTotals = restoredTokens.totals;
    const update = () => {
      if (storageUnavailable) setPersistent(false);
      const time = Date.now(); setNow(time);
      if (isLab) { setPhysicsMetric(physics.metrics()); if (machine.current) setRenderMetrics(machine.current.performance()); }
      if (session.current && !canRotateDaily(session.current.arrangement, time, busyRef.current)) return;
      const arrangement = dailyArrangement(playerId, time);
      if (pendingDayId === arrangement.id) return;
      pendingDayId = arrangement.id; changingDay.current = true; setReady(false);
      setLoadingState(previous => resetMachineLoading(previous));
      const cached = readInitialPileCache(storage.current, arrangement);
      void (cached ? Promise.resolve(cached) : physics.create(arrangement.seed)).then(initial => {
        if (cancelled || pendingDayId !== arrangement.id) return;
        if (!cached) saveInitialPileCache(storage.current, arrangement, initial);
        markLoaded("pile");
        let current = initial;
        try {
          if (storage.current) { current = restoreDailyPile(storage.current.getItem(dailyStorageKey(arrangement)), arrangement, initial) ?? initial; saveDailyPile(storage.current, arrangement, current); }
        } catch { setPersistent(false); }
        session.current = { arrangement, initialBoxes: initial, boxes: current };
        setInitialBoxes(initial); setBoxes(current); setDaily(arrangement); setOverrides({}); setTopView(false);
        setResult(null); setLastDraw(null); setHistory([]); setSimulation(null); setPhase("ready");
      }).catch(error => {
        if (cancelled || pendingDayId !== arrangement.id) return;
        console.error("Pile creation failed", error); pendingDayId = null; changingDay.current = false; setRenderError(true);
      });
    };
    refreshDay.current = update; const localSessionId = crypto.randomUUID(); const initialFrame = requestAnimationFrame(() => { setWithdrawalSessionId(localSessionId); setTotals(restoredTotals); setTokenWallet(restoredTokens); if (restoredTokens.pending) setTier(restoredTokens.pending.tier); update(); });
    const timer = window.setInterval(update, 1000);
    const wake = () => { if (!document.hidden) update(); };
    window.addEventListener("focus", update); document.addEventListener("visibilitychange", wake);
    return () => { cancelled = true; physics.dispose(); if (physicsRef.current === physics) physicsRef.current = null; cancelAnimationFrame(initialFrame); window.clearInterval(timer); window.removeEventListener("focus", update); document.removeEventListener("visibilitychange", wake); refreshDay.current = () => {}; };
  }, [isLab, markLoaded]);
  useEffect(() => {
    const currentSession = session.current;
    if (!fontsReady || !arrangementId || !host.current || !currentSession) return;
    const persist = (nextBoxes: PrizeBox[]) => {
      currentSession.boxes = nextBoxes;
      try { if (storage.current) saveDailyPile(storage.current, currentSession.arrangement, nextBoxes); }
      catch { setPersistent(false); }
    };
    try {
      const controller = createMachine(host.current, { ...currentSession, pickup: physicsRef.current?.pickup, plan: physicsRef.current?.plan }, (next) => { aimRef.current = next; if (isLab) setAim(next); }, next => { setPhase(next); if (next === "grabbing") playCue("grab"); }, (completed, settledBoxes) => {
        if (!isLab && recordedPlays.current.has(completed.pullId)) return;
        persist(settledBoxes);
        if (!isLab) recordTokenSession(completed.pullId);
        motionAudio(0, "hoist"); playCue(outcomeCue(completed.success, completed.cents));

        busyRef.current = false; setResult(completed); setHistory((prior) => [completed, ...prior].slice(0, 5)); setPhase("revealed");
        if (isLab && completed.success) setWonCents((total) => total + completed.cents);
        setBoxes(settledBoxes); setSimulation(null); refreshDay.current();
      }, async (pull) => {
        if (!isLab) {
          const pending = tokenWalletRef.current.pending, used = tokenWalletRef.current.used[pull.id];
          if ((!pending && !used) || (pending && (pending.id !== pull.id || pending.tier !== pull.tier)) || (used && used.tier !== pull.tier)
            || pull.priceUsd * 100 !== TOKEN_TYPES[pull.tier].priceCents) throw new Error("No matching token for this draw");
        }
        const resolved = await provider.current!.resolve(pull);
        if (!isLab) {
          const pending = tokenWalletRef.current.pending;
          if (pending && (pending.id !== pull.id || pending.tier !== pull.tier)) throw new Error("Draw does not match the inserted token");
          storeTokens(settleDemoToken(tokenWalletRef.current, pull.id, resolved.cents));
          machine.current?.setTokenReady(false);
        }
        setLastDraw(resolved); return resolved;
      }, (error) => {
        console.error(error); busyRef.current = false;
        if (!isLab && tokenWalletRef.current.pending) storeTokens(ejectDemoToken(tokenWalletRef.current, tokenWalletRef.current.pending.id));
        if (!isLab && activePlay.current) recordTokenSession(activePlay.current);
        machine.current?.setTokenReady(false); machine.current?.setPowered(false); setPhase("error"); refreshDay.current();
      }, persist, () => playCue("impact"), motionAudio);
      machine.current = controller;
      queueMicrotask(() => { if (machine.current === controller) markLoaded("scene"); });
      const config = engineConfig.current; controller.setConfig(config.tier, config.overrides, config.debug, config.currency);
      controller.setTheme(themeRef.current);
      controller.setView(currentView.current ? "top" : "front");
      controller.setTokenReady(!isLab && !!tokenWalletRef.current.pending);
      controller.setPowered(isLab || !!tokenWalletRef.current.pending);
      let cancelled = false;
      void controller.ready.then(() => { if (!cancelled) { changingDay.current = false; markLoaded("ready"); setReady(true); } }).catch(error => {
        if (cancelled) return;
        console.error("Machine shader warm-up failed", error); setRenderError(true);
      });
      const held = new Set<string>();
      const move = () => controller.move(Number(held.has("d") || held.has("arrowright")) - Number(held.has("a") || held.has("arrowleft")), Number(held.has("s") || held.has("arrowdown")) - Number(held.has("w") || held.has("arrowup")));
      const keydown = (event: KeyboardEvent) => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable], dialog")) return;
        const key = event.key.toLowerCase();
        if (["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright"].includes(key)) { event.preventDefault(); activateAudio(); held.add(key); move(); }
        else if (event.code === "Space" && !event.repeat && !(event.target instanceof HTMLElement && event.target.closest("button, a"))) { event.preventDefault(); dropAction.current(); }
      };
      const keyup = (event: KeyboardEvent) => { held.delete(event.key.toLowerCase()); move(); }, stop = () => { held.clear(); controller.move(0, 0); };
      const visibility = () => { if (document.hidden) stop(); };
      window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", stop); document.addEventListener("visibilitychange", visibility);
      return () => { cancelled = true; controller.dispose(); machine.current = null; busyRef.current = false; window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", visibility); };
    } catch (error) { console.error(error); const frame = requestAnimationFrame(() => setRenderError(true)); return () => cancelAnimationFrame(frame); }
  }, [arrangementId, isLab, fontsReady, storeTokens, recordTokenSession, playCue, motionAudio, activateAudio, markLoaded]);
  function buyTokens(type: TokenTier, quantity: number) {
    if (busyRef.current) return;
    storeTokens(buyDemoTokens(tokenWalletRef.current, crypto.randomUUID(), type, quantity));
    if (!tokenWalletRef.current.pending) setTier(type);
  }
  function withdrawWinnings(scope: WithdrawalScope) {
    if (isLab || !ready || busyRef.current || changingDay.current) throw new Error("Withdrawal unavailable during play");
    const previous = tokenWalletRef.current;
    const next = withdrawDemoWinnings(previous, crypto.randomUUID(), scope, withdrawalSessionId, sessionPlayIds);
    const amount = availableWinningsCents(previous) - availableWinningsCents(next);
    storeTokens(next);
    return amount;
  }
  function setSeed() {
    const seed = Number(seedDraft); if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return;
    setAppliedSeed(seed); provider.current = createPickupProvider(randomMode === "seeded" ? seededRandom(seed) : browserRandom, randomMode === "seeded" ? "seeded-debug" : "browser-demo");
    aimRandom.current = seededRandom((seed ^ 0xa5a5a5a5) >>> 0); setLastDraw(null); setSimulation(null);
  }
  function aimAt(x: number, z: number, immediate = false) { machine.current?.position("x", percent(x, ARENA.minX, ARENA.maxX), immediate); machine.current?.position("z", percent(z, ARENA.minZ, ARENA.maxZ), immediate); }
  function randomDrop() { if (busyRef.current) return; aimAt(ARENA.minX + aimRandom.current() * (ARENA.maxX - ARENA.minX), ARENA.minZ + aimRandom.current() * (ARENA.maxZ - ARENA.minZ), true); drop(); }
  function tune(key: "sigmaX" | "sigmaZ" | "maxPickupProbability" | "maxReach" | "exposure" | "gripSuitability", value: number) {
    if (!Number.isFinite(value)) return;
    const v = key.startsWith("sigma") ? Math.max(.01, Math.min(2, value)) : key === "maxReach" ? Math.max(0, Math.min(3, value)) : Math.max(0, Math.min(1, value));
    setOverrides((previous) => ({ ...previous, [editId]: { ...previous[editId], [key]: v } })); setSimulation(null);
  }
  function tunePoint(axis: "x" | "z", value: number) {
    if (!Number.isFinite(value) || !editable) return; const v = Math.max(axis === "x" ? ARENA.minX : ARENA.minZ, Math.min(axis === "x" ? ARENA.maxX : ARENA.maxZ, value));
    const point = overrides[editId]?.grabPoint ?? editable.grabPoint;
    setOverrides((previous) => ({ ...previous, [editId]: { ...previous[editId], grabPoint: { ...point, [axis]: v } } })); setSimulation(null);
  }
  function resetPile() {
    if (!session.current || busyRef.current || changingDay.current) return;
    if (needsDailyReset(session.current.arrangement, Date.now())) { refreshDay.current(); return; }
    machine.current?.resetPile(); const initial = [...session.current.initialBoxes]; session.current.boxes = initial; setBoxes(initial);
    try { if (storage.current) saveDailyPile(storage.current, session.current.arrangement, initial); } catch { setPersistent(false); }
    setResult(null); setLastDraw(null); setSimulation(null); setPhase("ready");
  }
  if (!daily || !editable) return <main className={isLab ? styles.arcade : playerStyles.arcade}><ArcadeLoading progress={loading.percent} label={loading.label} failed={fontError || renderError} draw="local" /></main>;
  if (!isLab) return <>
    <PlayerArcade host={host} daily={daily} now={now} tier={tier} ready={ready} busy={busy} loading={loading} entering={!everReady && !ready && !renderError && !fontError}
      renderError={renderError || fontError} topView={topView} empty={boxes.length === 0} persistent={persistent}
      availableWinningsCents={availableWinningsCents(tokenWallet)} sessionWithdrawableCents={sessionWithdrawableCents(tokenWallet, withdrawalSessionId, sessionPlayIds)} onWithdraw={withdrawWinnings}
      phase={phase} result={result} history={history} sessionWinningsCents={wonCents} totalWinningsCents={totals.prizeCents}
      tokenBalances={tokenWallet.balances} onBuyTokens={buyTokens}
      theme={theme} progress={progress} receipts={receipts}
      soundMuted={audio.muted} onSound={audio.toggleMuted} onActivateAudio={activateAudio}
      onTier={value => { if (!tokenWalletRef.current.pending && !busyRef.current) setTier(value); }} onDragAim={(x, y) => { if (!busyRef.current) machine.current?.dragAim(x, y); }}
      onView={() => { const next = !topView; setTopView(next); machine.current?.setView(next ? "top" : "front"); }} onDrop={insertAndDrop} />
  </>;
  const base = { ...editable, ...overrides[editId] }, effective = parametersFor(editable, tier, overrides, currency);
  const fields: { key: keyof Omit<GrabParameters, "grabPoint">; label: string; max: number }[] = [{ key: "sigmaX", label: "Sigma X", max: 2 }, { key: "sigmaZ", label: "Sigma Z (depth)", max: 2 }, { key: "maxPickupProbability", label: "Base peak (0–1)", max: 1 }, { key: "maxReach", label: "Max reach", max: 3 }, { key: "exposure", label: "Exposure", max: 1 }, { key: "gripSuitability", label: "Base grip suitability", max: 1 }];
  return <main className={styles.arcade}>
    <header className={styles.header}><a className={styles.brand} href="/claw" aria-label="CATO Arcade home"><span className={styles.brandIcon}>c.</span><span>cato</span></a><div className={styles.headerRight}><span className={styles.demoBadge}><span />Pickup probability lab</span><button className={styles.wallet} disabled><HiOutlineWallet /> Demo only</button></div></header>
    <section className={styles.dailyBanner} aria-label="Daily machine reset"><p>All claw machines get reset at 23:59 UTC.</p><div className={styles.dailyReset}><span>Your next reset is in:</span><strong>{countdown(daily.resetsAt, now)}</strong></div></section>
    <div className={styles.playLayout}><section className={styles.machineSection} aria-label="Claw machine playground">
      <div className={styles.stage}><div className={styles.stageTop}><span>CATO PILE / GRAVITY SETTLED</span><button className={styles.viewButton} aria-pressed={topView} disabled={!ready} onClick={() => { const next = !topView; setTopView(next); machine.current?.setView(next ? "top" : "front"); }}>{topView ? "Front view" : "Top view"}<HiOutlineViewfinderCircle /></button></div><div ref={host} className={styles.canvasHost} />{!ready && !renderError && !fontError && <div className={styles.loading}>Tumbling the boxes…</div>}{(renderError || fontError) && <div className={styles.loading} role="alert">{fontError ? "Machine font could not load. Refresh to retry." : "WebGL is required for this prototype."}</div>}<div className={styles.arenaStatus}><span>{busy ? "LOCKED TARGET" : "AIM TARGET"}<strong>{selection ? `${selection.box.id} · ${dollars(selection.box.cents)}` : "No box in reach"}</strong></span></div><div className={styles.stageHint}>{boxes.length}/{MACHINE.boxCount} boxes · {Math.max(0, ...boxes.map(boxTop)).toFixed(2)} / {MACHINE.height.toFixed(2)} height</div></div>
      <div className={styles.controlDeck}><div className={styles.controlLabel}><span>EXPLORE THE PILE</span><span className={styles.keyHint}>WASD / arrows · Space to drop</span></div><div className={styles.controls2d}><div className={styles.directionPad}>{DIRECTIONS.map((d) => <button key={d.key} data-key={d.key} className={styles.moveButton} disabled={busy || !ready} aria-label={`Move claw ${d.name}`} onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); machine.current?.move(d.dx, d.dz); }} onPointerUp={() => machine.current?.move(0, 0)} onPointerCancel={() => machine.current?.move(0, 0)} onLostPointerCapture={() => machine.current?.move(0, 0)} onClick={(e) => { if (e.detail === 0) aimAt(aimRef.current.x + d.dx * .15, aimRef.current.z + d.dz * .15); }}>{d.key}<span>{d.name}</span></button>)}</div><div className={styles.axisSliders}><div className={styles.sliderWrap}><label htmlFor="claw-x">Left ↔ right <span>{xPercent.toFixed(0)}%</span></label><input id="claw-x" aria-label="Left right position" type="range" min="0" max="100" step=".1" disabled={busy || !ready} value={xPercent} onChange={(e) => machine.current?.position("x", +e.target.value)} /></div><div className={styles.sliderWrap}><label htmlFor="claw-z">Back ↔ front <span>{zPercent.toFixed(0)}%</span></label><input id="claw-z" aria-label="Back front position" type="range" min="0" max="100" step=".1" disabled={busy || !ready} value={zPercent} onChange={(e) => machine.current?.position("z", +e.target.value)} /></div></div></div><p className={styles.controlNote}>Boxes tumble into a loose mound. Aim over an uncovered box. A box-sized grab area must be clear of higher blockers; deep gaps cannot target lower prizes. Green marks your target.</p></div>
      <section className={styles.lab} aria-label="Development overlay"><div className={styles.labHeader}><h2>Pickup debugger</h2><label><input type="checkbox" checked={debug} disabled={busy} onChange={(e) => setDebug(e.target.checked)} /> Show grab points + curves</label></div><div className={styles.debugReadouts}><span>World X / Z<strong>{aim.x.toFixed(3)} / {aim.z.toFixed(3)}</strong></span><span>Live target / odds<strong>{selection ? `${selection.box.id} · ${(selection.probability * 100).toFixed(2)}%` : "None · 0%"}</strong></span><span>Upward face tilt / grip factor<strong>{selection ? `${(Math.acos(Math.sqrt(upwardFaceGripFactor(selection.box))) * 180 / Math.PI).toFixed(1)}° · ${upwardFaceGripFactor(selection.box).toFixed(3)}×` : "—"}</strong></span><span>Stored target / odds<strong>{lastDraw ? (lastDraw.targetId ?? "None") + " · " + (lastDraw.probability * 100).toFixed(2) + "%" : "—"}</strong></span><span>Last roll [0, 1)<strong>{lastDraw?.roll != null ? lastDraw.roll.toFixed(6) : "—"}</strong></span><span>Draw outcome<strong>{lastDraw ? lastDraw.success ? "SUCCESS" : "MISS" : "Not drawn"}</strong></span></div>
      <details className={styles.tuning}><summary>Tune a box’s grab parameters</summary><label>Box<select aria-label="Box to tune" value={editId} disabled={busy} onChange={(e) => setEditId(e.target.value)}>{initialBoxes.map((box) => <option key={box.id} value={box.id}>{box.id} · {dollars(box.cents)}</option>)}</select></label><div className={styles.tuneFields}>{fields.map((field) => <label key={field.key}>{field.label}<input type="number" aria-label={field.label} min={field.key.startsWith("sigma") ? .01 : 0} max={field.max} step=".01" disabled={busy} value={base[field.key] ?? 1} onChange={(e) => tune(field.key, +e.target.value)} /></label>)}{(["x", "z"] as const).map((axis) => <label key={axis}>Grab point world {axis.toUpperCase()}<input aria-label={`Grab point ${axis.toUpperCase()}`} type="number" step=".01" disabled={busy} value={base.grabPoint[axis]} onChange={(e) => tunePoint(axis, +e.target.value)} /></label>)}</div><p>Current bet: peak {(effective.maxPickupProbability * (effective.exposure ?? 1) * (effective.gripSuitability ?? 1) * 100).toFixed(2)}%; widths {effective.sigmaX.toFixed(3)} / {effective.sigmaZ.toFixed(3)} world units. Upward face tilt {(Math.acos(Math.sqrt(upwardFaceGripFactor(editable))) * 180 / Math.PI).toFixed(1)}°; tilt factor {upwardFaceGripFactor(editable).toFixed(3)}×; effective grip {(effective.gripSuitability ?? 1).toFixed(3)}. Base grip is multiplied by the face tilt factor once, then locked for the attempt.</p><button disabled={busy || !boxes.some((b) => b.id === editId)} onClick={() => aimAt(base.grabPoint.x, base.grabPoint.z)}>Aim at this grab point</button><button disabled={busy} onClick={() => { setOverrides((prior) => { const next = { ...prior }; delete next[editId]; return next; }); setSimulation(null); }}>Reset box tuning</button></details>
      <div className={styles.seedControls}><label>Draw source<select aria-label="Draw source" disabled={busy} value={randomMode} onChange={(e) => { const next = e.target.value as "seeded" | "browser"; setRandomMode(next); provider.current = createPickupProvider(next === "seeded" ? seededRandom(appliedSeed) : browserRandom, next === "seeded" ? "seeded-debug" : "browser-demo"); setLastDraw(null); }}><option value="seeded">Seeded</option><option value="browser">Crypto</option></select></label><label>Seed<input aria-label="Debug seed" type="number" min="0" max="4294967295" value={seedDraft} disabled={busy} onChange={(e) => setSeedDraft(e.target.value)} /></label><button disabled={busy || !Number.isInteger(+seedDraft) || +seedDraft < 0 || +seedDraft > 0xffffffff} onClick={setSeed}>Apply / reset seed</button></div><p className={styles.labNote}>Applied seed: {appliedSeed}. {randomMode === "seeded" ? "Reset seed + pile + aim to reproduce an attempt." : "Browser crypto draws are not reproducible."}</p>
      {renderMetrics && <p className={styles.labNote}>Render: {renderMetrics.calls} calls · {Math.round(renderMetrics.triangles / 1000)}k triangles · {renderMetrics.geometries} geometries / {renderMetrics.textures} textures · DPR {renderMetrics.pixelRatio.toFixed(2)} · {(renderMetrics.pixels / 1e6).toFixed(2)}M pixels · frame CPU {renderMetrics.frameCpuMs.toFixed(1)}ms{renderMetrics.jsHeapMiB !== null ? ` · page JS heap ${renderMetrics.jsHeapMiB.toFixed(0)}MiB` : ""}. Physics: {physicsMetric?.worker ? "worker" : "fallback"} / {physicsMetric?.computeMs.toFixed(0) ?? "—"}ms. CPU submission time excludes GPU execution; heap covers the entire page.</p>}
      <div className={styles.labActions}><button disabled={busy || !ready} onClick={randomDrop}>Random aim + drop</button><button disabled={busy || !ready} onClick={resetPile}>Dev: restore daily pile</button></div>
      <div className={styles.simControls}><label>Batch aim<select aria-label="Batch aim" disabled={busy} value={testMode} onChange={(e) => { setTestMode(e.target.value as "random" | "aligned"); setSimulation(null); }}><option value="random">Random positions</option><option value="aligned">Perfect alignment</option></select></label><label>Trials<select aria-label="Trials" value={samples} onChange={(e) => { setSamples(+e.target.value); setSimulation(null); }}><option value="1000">1,000</option><option value="10000">10,000</option></select></label><button disabled={busy} onClick={() => setSimulation(simulatePickups(appliedSeed, samples, boxes, tier, overrides, testMode, currency))}>Run probability test</button></div>{simulation && <div className={styles.simResult} role="status"><strong>{simulation.successes}/{simulation.attempts} pickups · {(simulation.observedRate * 100).toFixed(2)}% observed</strong><span>{(simulation.expectedRate * 100).toFixed(2)}% predicted · 3σ tolerance ±{(simulation.tolerance * 100).toFixed(2)} percentage points</span><span>{Math.abs(simulation.observedRate - simulation.expectedRate) <= simulation.tolerance + 1e-12 ? "Within statistical tolerance" : "Outside tolerance; investigate or run more trials"} · {simulation.noTarget} positions without a target</span></div>}<p className={styles.labNote}>Batch tests repeat against the current pile; they do not remove boxes or award prizes.</p></section>
    </section><aside className={styles.playPanel}><div className={styles.panelHeading}><span className={styles.eyebrow}>CHOOSE THE GRIP DIFFICULTY</span><h2>Pick your bet<span>✳</span></h2><p>Each box’s value stays fixed. Your bet changes its pickup curve.</p></div><div className={styles.tiers}>{BET_TIERS.map((bet, i) => <button key={i} className={`${styles.tier} ${tier === i ? styles.tierActive : ""}`} aria-pressed={tier === i} disabled={busy} onClick={() => { setTier(i); setSimulation(null); }}><span>Tier {i + 1}</span><strong>${entryPriceUsd(i, currency)}</strong><small>USDC</small><small>{bet.peakMultiplier}× peak</small><small>{bet.widthMultiplier}× width</small></button>)}</div><p className={styles.quoteNote}>USDC entries only. The 5% minimum operating-margin cap uses the base play price. Top view is free for all players.</p><div className={styles.prizeRange}><span>SELECTED FIXED PRIZE</span><strong>{selection ? dollars(selection.box.cents) : "—"}</strong><p>{selection ? `${selection.box.id} · exposed face` : "Move within reach of an exposed box."}</p></div><div className={styles.selectedOdds}><HiOutlineSparkles /><div><strong>{((selection?.probability ?? 0) * 100).toFixed(2)}% pickup chance</strong><span>{selection ? `Offset X ${(aim.x - selection.parameters.grabPoint.x).toFixed(3)} / Z ${(aim.z - selection.parameters.grabPoint.z).toFixed(3)}` : "No target: the attempt will miss."}</span></div></div><div className={styles.result} role="status" aria-live="polite"><div>{result ? <><span>{result.targetId ?? "NO TARGET"} · {result.success ? "PICKUP SUCCESS" : "MISSED GRIP"}</span><strong>{result.success ? `${dollars(result.cents)} USDC` : "No prize"}</strong><p>Odds {(result.probability * 100).toFixed(2)}% · roll {result.roll?.toFixed(6) ?? "not needed"}</p></> : <><span>{busy ? "ATTEMPT LOCKED" : "READY WHEN YOU ARE"}</span><p>{PHASE_COPY[phase]}</p></>}</div></div><button className={styles.dropButton} disabled={busy || !ready} onClick={drop}>{busy ? "Claw in motion…" : "Drop & try pickup"}<HiOutlineArrowUpRight /></button><div className={styles.priceSummary}>Selected: {price} USDC<span>No funds charged</span></div><div className={styles.demoNotice}>Local demo: draws occur once at closure. A miss pays nothing. Parameters are experimental. Real payments and MagicBlock VRF are not connected; valuable-prize results must be resolved authoritatively onchain.</div></aside></div>
    <section className={styles.bottomRow}><div className={styles.cubeCard}><div className={styles.cubeMark}>c.</div><div><h3>{boxes.length} boxes remaining · {exposedBoxes(boxes).length} exposed</h3><p>Tumbled boxes settle under gravity. Pickups let the pile shift.</p></div></div><div className={styles.history}><span className={styles.eyebrow}>RECENT ATTEMPTS</span><div className={styles.historyAmounts}>{history.length ? history.map((entry) => <span key={entry.pullId}>{entry.targetId ?? "Empty"} · {entry.success ? dollars(entry.cents) : "miss"}</span>) : <p>No attempts yet.</p>}</div></div></section><footer className={styles.footer}><span>CATO ARCADE · PICKUP LAB</span><span>Aim. Grip. Test.</span></footer>
    {!persistent && <p className={styles.labNote}>Storage is unavailable. Machine progress is saved only for this session.</p>}
  </main>;
}
