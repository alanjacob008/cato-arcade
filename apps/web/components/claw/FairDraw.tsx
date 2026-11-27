import type { PullResult } from "./rewards";
import type { PlayReceipt } from "./PlayReceipts";
import { vrfExplorerLink, type VrfExecution } from "./vrfExplorer";
import hud from "./hud.module.css";

/**
 * Display-only facts the play flow already has about the current draw. `noTarget` comes from the locked
 * pull itself: with no box under the claw the backend settles the play at once and requests no VRF.
 */
export type DrawProgress = { id: string; deliveredMs: number | null; noTarget?: boolean };

type Props = {
  /** "vrf" only on the devnet player flow; the offline demo draws locally and never claims VRF. */
  mode: "vrf" | "local";
  busy: boolean; result: PullResult | null; receipts: readonly PlayReceipt[];
  execution?: VrfExecution; draw?: DrawProgress | null;
};
type State = "ready" | "waiting" | "drawing" | "delivered" | "verified" | "noTarget" | "unverified"
  | "local-ready" | "local-drawing" | "local-done" | "local-noTarget";

const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const spokenSeconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} seconds`;

/** A compact strip on the deck that follows the current play's draw: ready, drawing, then verified with its proof. */
export default function FairDraw({ mode, busy, result, receipts, execution, draw }: Props) {
  const receipt = result ? receipts.find(item => item.id === result.pullId) : undefined;
  const proof = receipt?.vrf, callback = vrfExplorerLink(proof?.callbackSignature, execution), request = vrfExplorerLink(proof?.requestSignature, execution);
  const delivered = !!draw && draw.deliveredMs !== null;
  let state: State;
  if (mode === "local") state = busy ? "local-drawing" : !result ? "local-ready" : result.targetId === null ? "local-noTarget" : "local-done";
  // Until the locked pull says whether a box is under the claw, the strip claims no request at all.
  else if (busy) state = !draw ? "waiting" : draw.noTarget ? "noTarget" : delivered ? "delivered" : "drawing";
  else if (!result) state = "ready";
  else if (draw?.id === result.pullId && draw.noTarget || result.targetId === null && !proof?.requestSignature && !proof?.callbackSignature) state = "noTarget";
  else if (result.source === "magicblock-vrf" && callback && request) state = "verified";
  else state = "unverified";
  const rollup = execution === "er" ? " on an Ephemeral Rollup" : "";
  const timing = draw && result && draw.id === result.pullId && draw.deliveredMs !== null ? `in ${seconds(draw.deliveredMs)}` : "";
  // The time is a tail that never breaks apart, so a wrapped line reads "… confirmed / in 3.2 s".
  const copy: Record<State, [string, string, string?]> = {
    "ready": ["FAIR DRAW", `MagicBlock VRF decides each grab${rollup}`],
    "waiting": ["FAIR DRAW", `MagicBlock VRF decides each grab${rollup}`],
    "drawing": ["DRAWING", "Requesting MagicBlock VRF…"],
    "delivered": ["DELIVERED", "VRF randomness received", draw?.deliveredMs ? `in ${seconds(draw.deliveredMs)}` : ""],
    "verified": ["VERIFIED", "VRF callback confirmed", timing],
    "noTarget": ["NO DRAW", "No box under the claw, so no VRF request"],
    "unverified": ["RECEIPT", "Proof link not available for this play"],
    "local-ready": ["DEMO DRAW", "Local randomness in this demo · no VRF"],
    "local-drawing": ["DEMO DRAW", "Demo play in progress · local randomness, no VRF"],
    "local-done": ["DEMO DRAW", "Drawn locally · demo only, no VRF proof"],
    "local-noTarget": ["NO DRAW", "No box under the claw, so nothing was drawn"],
  };
  // One plain sentence per state for screen readers: announced once when the state changes, never on load.
  // "waiting" says nothing new, so it stays silent; the next real state is then the one announcement.
  const spokenTiming = draw && result && draw.id === result.pullId && draw.deliveredMs !== null ? ` in ${spokenSeconds(draw.deliveredMs)}` : "";
  const spoken: Record<State, string> = {
    "ready": `Fair draw. MagicBlock VRF decides each grab${rollup}.`,
    "waiting": "",
    "drawing": "Requesting a MagicBlock VRF draw.",
    "delivered": `VRF randomness received${draw?.deliveredMs ? ` in ${spokenSeconds(draw.deliveredMs)}` : ""}.`,
    "verified": `Draw verified. VRF callback confirmed${spokenTiming}. View proof opens it in Solana Explorer.`,
    "noTarget": "No box under the claw, so no VRF request was made.",
    "unverified": "Proof link not available for this play.",
    "local-ready": "Demo draw. Local randomness in this demo, no VRF.",
    "local-drawing": "Demo play in progress. Local randomness, no VRF.",
    "local-done": "Drawn locally. Demo only, no VRF proof.",
    "local-noTarget": "No box under the claw, so nothing was drawn.",
  };
  const [label, detail, tail] = copy[state];
  const tone = state === "noTarget" || state === "unverified" || state === "local-noTarget" ? "quiet" : state.startsWith("local") ? "local" : "proof";
  return <div className={hud.fairDraw} data-state={state} data-tone={tone}>
    <span className={hud.drawLamp} aria-hidden="true">{state === "verified" ? <svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg> : null}</span>
    <span className={hud.drawText} aria-hidden="true"><strong>{label}</strong><span>{detail}{tail ? <> <span className={hud.drawTime}>{tail}</span></> : null}</span></span>
    <span className={hud.spoken} role="status" aria-live="polite" aria-atomic="true">{spoken[state]}</span>
    {state === "verified" && callback && <a className={hud.drawLink} href={callback} target="_blank" rel="noopener noreferrer" aria-label="View the VRF proof for this play (opens in new tab)">View proof<span aria-hidden="true">↗</span></a>}
  </div>;
}
