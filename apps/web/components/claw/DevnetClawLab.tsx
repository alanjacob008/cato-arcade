"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createMachine, type MachineController, type MachinePhase } from "./createMachine";
import { createPhysicsService } from "./physicsService";
import { dailyArrangement, type DailyArrangement } from "./daily";
import { resolvePull, type LockedPull, type PrizeBox, type PullResult } from "./rewards";
import { loadMachineFont } from "./machineTypography";
import { loadPrizeLogo } from "./prizeModel";
import { loadPavementTexture } from "./pavementScene";
import { createDevnetVrf, type VrfTimingEvent, type DevnetAvailability } from "./devnetVrf";
import { useArcadeAudio } from "./useArcadeAudio";
import PlayerArcade from "./PlayerArcade";
import ArcadeLoading from "./ArcadeLoading";
import { isTokenQuantity, TOKEN_TYPES, type TokenTier } from "./tokens";
import type { ClubReceipt } from "./clubCosmetics";
import { EMPTY_LOADING, completeLoadingTask, loadingProgress, resetMachineLoading, type LoadingTask } from "./loadingProgress";
import styles from "./devnet.module.css";
import AuthoritativeArcade from "./AuthoritativeArcade";

type Row = { id: string; events: Record<string, number>; request?: string; callback?: string;
  oracleMs?: number; prepareMs?: number; confirmMs?: number; slots?: number; cents?: number; recovered?: boolean };
type Snapshot = { version: 1; arrangement: DailyArrangement; initialBoxes: PrizeBox[]; boxes: PrizeBox[];
  balances: number[]; pending: LockedPull | null; completed: Record<string, number>; results?: PullResult[]; receipts?: ClubReceipt[] };
const seconds = (ms: number | undefined) => ms === undefined ? "—" : `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
const elapsed = (row: Row, from: string, to: string) => row.events[from] === undefined || row.events[to] === undefined ? undefined : row.events[to] - row.events[from];
const explorer = (signature: string) => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
const labels: Record<string, string> = { started: "Preparing locked VRF request", "wallet-prompt": "Approve the devnet request in Phantom",
  sponsored: "VRF request broadcast by CATO sponsor",
  "wallet-approved": "Submitting approved request", "request-confirmed": "Request confirmed; waiting for callback",
  "callback-pending": "Waiting for the same MagicBlock callback", "rpc-retry": "RPC unavailable; keeping this attempt pending",
  "checking-submission": "Checking the signed request; no reroll", "result-ready": "Verified VRF result received",
  "no-target": "No reachable box here; no VRF request needed" };

export default function DevnetClawLab({ execution = "base", presentation = "diagnostic" }: { execution?: "base" | "er"; presentation?: "player" | "diagnostic" }) {
  return presentation === "player" ? <AuthoritativeArcade /> : <DiagnosticClawLab execution={execution} presentation={presentation} />;
}
function DiagnosticClawLab({ execution, presentation }: { execution: "base" | "er"; presentation: "player" | "diagnostic" }) {
  const [authority, setAuthority] = useState(""), [setup, setSetup] = useState<Snapshot | null>(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(""), [status, setStatus] = useState("Connect the devnet test wallet to begin.");
  const [tier, setTier] = useState(0), [balances, setBalances] = useState<number[]>([10, 10, 10]);
  const [pending, setPending] = useState<LockedPull | null>(null), [result, setResult] = useState<PullResult | null>(null);
  const [rows, setRows] = useState<Row[]>([]), [top, setTop] = useState(false), [revision, setRevision] = useState(0);
  const [clock, setClock] = useState(0);
  const [loadingState, setLoadingState] = useState(EMPTY_LOADING);
  const markLoaded = useCallback((task: LoadingTask) => setLoadingState(previous => completeLoadingTask(previous, task)), []);
  const loading = loadingProgress(loadingState);
  const [playerHistory, setPlayerHistory] = useState<PullResult[]>([]), [visitWinnings, setVisitWinnings] = useState(0);
  const [availability, setAvailability] = useState<DevnetAvailability | null>(null), [checking, setChecking] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const audio = useArcadeAudio(), playCue = audio.playCue;
  const host = useRef<HTMLDivElement>(null), machine = useRef<MachineController | null>(null);
  const snapshot = useRef<Snapshot | null>(null), storageKey = useRef("");
  const active = useRef<LockedPull | null>(null), blocked = useRef(false), alive = useRef(true);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const client = useRef<ReturnType<typeof createDevnetVrf> | null>(null);
  const dropAction = useRef<() => void>(() => {});
  const eventTimes = useRef<Record<string, Record<string, number>>>({});
  const timingSink = useRef<(event: VrfTimingEvent) => void>(() => {});
  const ensureClient = useCallback(() => client.current ??= createDevnetVrf(event => timingSink.current(event), execution, presentation === "player"), [execution, presentation]);
  const refreshAvailability = useCallback(async () => {
    if (alive.current) setChecking(true);
    try {
      const current = await ensureClient().availability();
      if (current.execution !== execution || current.cluster !== "devnet") throw Error("Wrong test server. Open the local rollup preview link.");
      if (alive.current) { setAvailability(current); setAvailabilityError(""); }
    } catch { if (alive.current) { setAvailability(null); setAvailabilityError("Unable to check sponsored plays. Refresh availability to retry."); } }
    finally { if (alive.current) setChecking(false); }
  }, [ensureClient, execution]);
  function persist() { try { if (snapshot.current && storageKey.current) localStorage.setItem(storageKey.current, JSON.stringify(snapshot.current)); } catch { setError("Test progress could not be saved. Keep this tab open until the result arrives."); } }
  function mark(id: string, phase: string, at = Date.now()) {
    if (!alive.current) return;
    eventTimes.current[id] ??= {}; eventTimes.current[id][phase] ??= at;
    setRows(old => {
      const existing = old.find(row => row.id === id) ?? { id, events: {} };
      const row = { ...existing, events: { ...existing.events, [phase]: existing.events[phase] ?? at } };
      return [row, ...old.filter(item => item.id !== id)].slice(0, 30);
    });
  }
  function timing(event: VrfTimingEvent) {
    if (!alive.current) return;
    mark(event.pullId, event.phase, event.at); setStatus(labels[event.phase] ?? event.phase);
    const receipt = event.receipt;
    if (receipt?.result) setRows(old => old.map(row => row.id !== event.pullId ? row : { ...row,
      request: receipt.requestSignature ?? undefined, callback: receipt.callbackSignature ?? undefined,
      prepareMs: receipt.timings.submittedAt ? receipt.timings.submittedAt - (receipt.timings.preparationStartedAt ?? receipt.timings.lockedAt) : undefined,
      confirmMs: receipt.timings.submittedAt && receipt.timings.confirmedAt ? receipt.timings.confirmedAt - receipt.timings.submittedAt : undefined,
      oracleMs: receipt.timings.submittedAt && receipt.timings.callbackVerifiedAt ? receipt.timings.callbackVerifiedAt - receipt.timings.submittedAt : undefined,
      slots: receipt.timings.requestedSlot && receipt.timings.fulfilledSlot ? Number(BigInt(receipt.timings.fulfilledSlot) - BigInt(receipt.timings.requestedSlot)) : undefined }));
  }
  useEffect(() => { timingSink.current = timing; });
  useEffect(() => {
    if (presentation !== "player") return;
    const initial = setTimeout(() => void refreshAvailability(), 0);
    const interval = setInterval(() => { if (!active.current) void refreshAvailability(); }, 15000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [presentation, refreshAvailability]);
  function complete(completed: PullResult, boxes: PrizeBox[], recovered = false) {
    const model = snapshot.current; if (!model || !alive.current) return;
    if (!Object.hasOwn(model.completed, completed.pullId)) {
      model.completed[completed.pullId] = completed.cents; model.boxes = boxes;
      model.results = [completed, ...(model.results ?? []).filter(item => item.pullId !== completed.pullId)].slice(0, 50);
      const playedTier = (model.pending?.tier ?? 0) as TokenTier, entryCents = TOKEN_TYPES[playedTier].priceCents;
      model.receipts = [{ id: completed.pullId, tier: playedTier, entryCents, prizeCents: completed.cents, netCents: completed.cents - entryCents }, ...(model.receipts ?? [])].slice(0, 50);
      setPlayerHistory([...model.results]); setVisitWinnings(previous => previous + completed.cents);
    }
    model.pending = null; active.current = null; blocked.current = false; persist();
    mark(completed.pullId, "finished"); setRows(old => old.map(row => row.id === completed.pullId ? { ...row, cents: completed.cents, recovered } : row));
    if (completed.targetId) void client.current?.recordTiming(completed.pullId, eventTimes.current[completed.pullId]).catch(() => {});
    setPending(null); setBusy(false); setResult(completed); setStatus(recovered ? "Recovered the locked result. Animation replay skipped." : "Attempt complete.");
    machine.current?.setTokenReady(false); playCue(completed.success ? "win" : "miss");
    if (presentation === "player") void refreshAvailability();
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!busy && presentation !== "player") return; const timer = setInterval(() => setClock(Date.now()), busy ? 250 : 1000); return () => clearInterval(timer); }, [busy, presentation]);
  async function connect() {
    setConnecting(true); setError("");
    try {
      const wallet = await ensureClient().connect(); setReady(false); setLoadingState(previous => resetMachineLoading(previous)); setStatus("Loading your isolated test inventory…"); setAuthority(wallet);
      if (presentation === "player") await refreshAvailability();
    } catch (value) { setError(value instanceof Error ? value.message : "Wallet connection failed."); }
    finally { setConnecting(false); }
  }
  useEffect(() => {
    const physics = createPhysicsService(); let cancelled = false;
    void (async () => {
      storageKey.current = `cato-vrf-${execution === "er" ? "er-" : ""}devnet-lab-v1:${authority || "preview"}`;
      let saved: Snapshot | null = null;
      try { saved = JSON.parse(localStorage.getItem(storageKey.current) ?? "null"); } catch { /* Fresh isolated test inventory. */ }
      if (!saved || saved.version !== 1 || !Array.isArray(saved.boxes) || !Array.isArray(saved.balances)) {
        const arrangement = dailyArrangement(`devnet:${authority || "preview"}`, Date.now());
        const boxes = await physics.create(arrangement.seed);
        saved = { version: 1, arrangement, initialBoxes: boxes, boxes, balances: [10, 10, 10], pending: null, completed: {} };
      }
      markLoaded("pile");
      await Promise.all([loadMachineFont().then(() => markLoaded("font")), loadPrizeLogo().then(() => markLoaded("logo")), loadPavementTexture(markLoaded)]);
      const latest = authority ? await client.current!.latest() : null;
      if (latest?.pull && !Object.hasOwn(saved.completed, latest.pull.id) && (latest.pending || saved.pending?.id === latest.pull.id)) saved.pending = latest.pull;
      if (saved.pending) resolvePull(saved.pending, () => 0, "magicblock-vrf");
      if (cancelled) return;
      snapshot.current = saved; setSetup(saved); setBalances([...saved.balances]); setPending(saved.pending); setPlayerHistory(saved.results ?? []); setClock(Date.now()); persist();
      setStatus(saved.pending ? "A locked test attempt needs recovery. Resume it before starting another." : authority ? "Aim, select a test token, then Insert & Drop." : "Connect the devnet test wallet to begin.");
    })().catch(value => { if (!cancelled) setError(value instanceof Error ? value.message : "Machine initialization failed."); });
    return () => { cancelled = true; physics.dispose(); };
  }, [authority, execution, markLoaded]);
  useEffect(() => {
    if (!setup || !host.current) return;
    const physics = createPhysicsService(); let disposed = false;
    const fail = (value: unknown) => {
      if (disposed) return;
      const model = snapshot.current, pull = active.current;
      // Keep the reservation even after a rejected wallet prompt or a rendering
      // failure. Recovery uses the same ID/target/nonce and never charges twice.
      blocked.current = !!model?.pending; active.current = pull; setPending(model?.pending ?? null); setBusy(false);
      setStatus("Attempt paused. Resume the same locked attempt; its test token is reserved.");
      setError(value instanceof Error ? value.message : "Attempt failed.");
    };
    let controller: MachineController;
    try {
      controller = createMachine(host.current, { initialBoxes: setup.initialBoxes, boxes: snapshot.current!.boxes, arrangement: setup.arrangement, pickup: physics.pickup, plan: physics.plan },
        () => {}, (phase: MachinePhase) => { if (active.current) mark(active.current.id, phase); if (["descending", "lifting", "delivering"].includes(phase)) playCue("motor"); },
        (outcome, boxes) => complete(outcome, boxes), pull => client.current!.resolve(pull), fail,
        boxes => { if (snapshot.current) { snapshot.current.boxes = boxes; persist(); } }, () => playCue("impact"));
      machine.current = controller; controller.setConfig(0, {}, false, "USDC"); controller.setTheme("violet");
      void controller.ready.then(() => { if (!disposed) { markLoaded("scene"); markLoaded("ready"); setReady(true); } }).catch(fail);
    } catch (value) { fail(value); return () => physics.dispose(); }
    const held = new Set<string>();
    const move = () => controller.move(Number(held.has("d") || held.has("arrowright")) - Number(held.has("a") || held.has("arrowleft")), Number(held.has("s") || held.has("arrowdown")) - Number(held.has("w") || held.has("arrowup")));
    const stop = () => { held.clear(); controller.move(0, 0); };
    const down = (event: KeyboardEvent) => {
      if (blocked.current || event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLElement && event.target.closest("button,input,a,dialog")) return;
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) { event.preventDefault(); held.add(key); move(); }
      if (event.code === "Space" && !event.repeat) { event.preventDefault(); dropAction.current(); }
    };
    const up = (event: KeyboardEvent) => { held.delete(event.key.toLowerCase()); move(); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", stop);
    return () => { disposed = true; controller.dispose(); physics.dispose(); machine.current = null; setReady(false); window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", stop); };
  // Scene recreation happens only on initialization or explicit recovery, never on timer/UI updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, revision, playCue, markLoaded]);
  useEffect(() => { machine.current?.setConfig(tier, {}, false, "USDC"); machine.current?.setView(top ? "top" : "front"); }, [tier, top, ready, revision]);
  function drop() {
    const model = snapshot.current, controller = machine.current;
    if (!authority || !ready || blocked.current || !controller || !model || model.pending || !model.balances[tier]) return;
    if (presentation === "player" && (!availability?.sponsor.ready || !availability.sponsor.expiresAt || availability.sponsor.expiresAt <= Date.now() / 1000)) return;
    const pull = controller.prepareDrop(crypto.randomUUID(), tier, "USDC", {}); if (!pull) return;
    model.pending = pull; model.balances[tier]--; active.current = pull; blocked.current = true; persist();
    if (presentation === "player" && pull.target) setAvailability(previous => previous ? { ...previous,
      sponsor: { ...previous.sponsor, remaining: Math.max(0, previous.sponsor.remaining - 1), ready: previous.sponsor.remaining > 1 } } : null);
    setBalances([...model.balances]); setPending(pull); setBusy(true); setError(""); setResult(null); setClock(Date.now()); mark(pull.id, "pressed");
    audio.activate();
    // Start the oracle request while the existing insertion/descent animation runs.
    // The engine awaits this same cached promise at its grab point.
    void client.current!.resolve(pull).catch(() => {});
    mark(pull.id, "inserting");
    void controller.insertToken(tier, true).then(() => playCue("insert")).catch(value => {
      // A rendering failure must not discard an already-started VRF request.
      setBusy(false); setError(`Animation interrupted. Resume the locked attempt. ${value instanceof Error ? value.message : ""}`);
    });
  }
  useEffect(() => { dropAction.current = drop; });
  async function recover() {
    const pull = snapshot.current?.pending; if (!pull || busy || !client.current) return;
    active.current = pull; blocked.current = true; setBusy(true); setError(""); mark(pull.id, "recovery-started");
    try {
      const outcome = await client.current.resolve(pull);
      const boxes = snapshot.current!.boxes.filter(box => !outcome.success || box.id !== outcome.targetId);
      complete(outcome, boxes, true); setRevision(value => value + 1);
    } catch (value) { setBusy(false); setError(value instanceof Error ? value.message : "Recovery failed; the same attempt is preserved."); }
  }
  const activeRow = rows[0], testWinnings = setup ? Object.values(setup.completed).reduce((sum, cents) => sum + cents, 0) : 0;
  const measured = rows.map(row => row.oracleMs).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  if (presentation === "player") {
    if (!setup) return <div className={styles.lab}><ArcadeLoading progress={loading.percent} label={loading.label} failed={!!error} /></div>;
    const activeSponsor = !!availability?.sponsor.ready && (availability.sponsor.expiresAt ?? 0) > clock / 1000;
    function addTokens(selected: TokenTier, quantity: number) {
      const model = snapshot.current;
      if (!authority || !model || blocked.current || model.pending || !isTokenQuantity(quantity) || model.balances[selected] + quantity > 10000) throw Error("Unable to add test tokens.");
      model.balances[selected] += quantity; setBalances([...model.balances]); persist();
    }
    return <PlayerArcade host={host} daily={setup.arrangement} now={clock} tier={tier} ready={ready} busy={busy}
      renderError={false} topView={top} empty={!setup.boxes.length} persistent loading={loading}
      phase={busy ? "playing" : "ready"} result={result} history={playerHistory} sessionWinningsCents={visitWinnings} totalWinningsCents={testWinnings}
      availableWinningsCents={0} sessionWithdrawableCents={0} onWithdraw={() => 0} tokenBalances={balances as [number, number, number]}
      theme="violet" progress={{ plays: Object.keys(setup.completed).length, catches: Object.values(setup.completed).filter(cents => cents > 0).length, rareCatches: Object.values(setup.completed).filter(cents => cents >= 1000).length }} receipts={setup.receipts ?? []}
      soundMuted={audio.muted} onSound={audio.toggleMuted} onBuyTokens={addTokens} onTier={setTier}
      onDragAim={(x, z) => { if (!blocked.current && !pending) machine.current?.dragAim(x, z); }} onView={() => setTop(value => !value)} onDrop={drop}
      testSession={{ wallet: authority, connecting, onConnect: () => void connect(), pending: !!pending, onResume: () => void recover(), active: activeSponsor,
        remaining: availability?.sponsor.remaining ?? null, checking, error: [error, availabilityError].filter(Boolean).join(" "), onRefresh: () => void refreshAvailability() }} />;
  }
  return <main className={styles.lab}>
    <header><div><h1>Claw · {execution === "er" ? "rollup" : "base-layer"} devnet timing test</h1><p>CATO pays devnet VRF fees. No per-drop wallet signatures. Test prizes cannot be withdrawn.</p></div>
      <button disabled={connecting || !!authority} onClick={() => void connect()}>{authority ? `${authority.slice(0, 5)}…${authority.slice(-4)} connected` : connecting ? "Connecting…" : "Connect Phantom"}</button></header>
    <div className={styles.layout}>
      <section className={styles.stage} aria-label="Devnet claw machine">
        <div ref={host} className={styles.canvas} tabIndex={0} role="group" aria-label="Aim the claw with drag, WASD or arrow keys"
          onPointerDown={event => { if (!ready || blocked.current || pending || !event.isPrimary || event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY }; }}
          onPointerMove={event => { const p = pointer.current; if (!p || p.id !== event.pointerId || blocked.current) return; const rect = event.currentTarget.getBoundingClientRect(); machine.current?.dragAim((event.clientX - p.x) / rect.width, (event.clientY - p.y) / rect.height); pointer.current = { id: p.id, x: event.clientX, y: event.clientY }; }}
          onPointerUp={() => { pointer.current = null; }} onLostPointerCapture={() => { pointer.current = null; }} />
        <button className={styles.view} disabled={!ready || busy} onClick={() => { machine.current?.setView(top ? "front" : "top"); setTop(!top); }}>{top ? "Front view" : "Top view"}</button>
        {!ready && <p className={styles.overlay}>{authority ? "Loading machine…" : "Connect Phantom to load the local test."}</p>}
        {result && !busy && <p className={styles.outcome} data-win={result.success}>{result.success ? `You won ${(result.cents / 100).toFixed(2)} test USDC` : "Better luck next time"}</p>}
      </section>
      <aside className={styles.panel}>
        <h2>Test tokens</h2><div className={styles.tokens}>{["Silver", "Gold", "Diamond"].map((name, index) => <button key={name} aria-pressed={tier === index} disabled={!ready || busy || !!pending} onClick={() => { setTier(index); machine.current?.setConfig(index, {}, false, "USDC"); }}>{name}<small>{balances[index]} available</small></button>)}</div>
        <button className={styles.play} disabled={!authority || !ready || busy || !!pending || !balances[tier]} onClick={drop}>INSERT & DROP</button>
        <button disabled={!authority || !ready || busy || !!pending} onClick={() => { if (!snapshot.current) return; snapshot.current.balances = balances.map(value => value + 10); setBalances([...snapshot.current.balances]); persist(); }}>Add 10 of each test token</button>
        {pending && !busy && <button onClick={() => void recover()}>Resume locked attempt</button>}
        <p role="status" aria-live="polite">{status}</p>{error && <p className={styles.error} role="alert">{error.replaceAll("_", " ")}</p>}
        <p>Test winnings: {(testWinnings / 100).toFixed(2)} · no withdrawals</p>
        {busy && activeRow && <strong>Elapsed: {seconds(clock - (activeRow.events.pressed ?? activeRow.events["recovery-started"] ?? clock))}</strong>}
        <h2>Timing · {measured.length} VRF results</h2>
        <p>Send → verified result: median {seconds(measured.length ? measured[Math.floor(measured.length / 2)] : undefined)}. Includes confirmation and callback checks.</p>
        <button disabled={!rows.length} onClick={() => { const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "cato-devnet-timings.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download timings</button>
      </aside>
    </div>
    <section className={styles.results} aria-label="Attempt timings"><table><thead><tr><th>Attempt</th><th>Prepare request</th><th>Wallet approval</th><th>Send → confirm</th><th>Send → verified</th><th>Wait after grip</th><th>Full play</th><th>Onchain slots</th><th>Receipts</th></tr></thead><tbody>{rows.map((row, index) => <tr key={row.id}>
      <td>{rows.length - index}{row.cents !== undefined ? ` · ${row.cents ? `+${row.cents / 100}` : "miss"}` : " · pending"}{row.events["no-target"] ? " · no VRF" : ""}{row.recovered ? " · recovered" : ""}</td>
      <td>{seconds(row.prepareMs)}</td><td>{row.request ? "None · sponsored" : "—"}</td><td>{seconds(row.confirmMs)}</td><td>{seconds(row.oracleMs)}</td>
      <td>{seconds(elapsed(row, "waiting", "lifting"))}</td><td>{seconds(elapsed(row, "pressed", "finished"))}</td><td>{row.slots ?? "—"}</td>
      <td>{row.request && <a href={explorer(row.request)} target="_blank" rel="noreferrer">Request</a>} {row.callback && <a href={explorer(row.callback)} target="_blank" rel="noreferrer">Callback</a>}</td>
    </tr>)}</tbody></table></section>
  </main>;
}
