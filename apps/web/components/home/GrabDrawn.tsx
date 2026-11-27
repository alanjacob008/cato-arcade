import { LanesDiagram } from "./LanesDiagram";
import styles from "./home.module.css";

/**
 * "How a grab is drawn": the VRF path as a pulsing lanes diagram, with three facts that are true
 * today (CLAW_BACKEND_HANDOFF.md, docs/claw/eight-lane-rollout.md, docs/claw/latency-2026-11-24.md).
 */
export function GrabDrawn() {
  return (
    <section id="how-a-grab-is-drawn" className={styles.drawn} aria-labelledby="how-a-grab-is-drawn-title">
      <div className={styles.drawnWrap}>
        <div className={styles.drawnText}>
          <h2 id="how-a-grab-is-drawn-title" className={styles.drawnTitle}>How a grab is drawn</h2>
          <p className={styles.drawnLead}>
            You press Insert &amp; Drop, and the arcade asks MagicBlock for a random number while the claw goes down.
          </p>
          <ul className={styles.facts}>
            <li>
              <h3>Four VRF lanes</h3>
              <p>Four lanes are live on devnet, so four grabs can be drawn at once. Four more are approved.</p>
            </li>
            <li>
              <h3>A MagicBlock Ephemeral Rollup</h3>
              <p>Each draw runs on the rollup. In our measured plays, the answer came two rollup slots after the request.</p>
            </li>
            <li>
              <h3>Proof before payout</h3>
              <p>The arcade checks the callback before it credits a win. Every receipt links both transactions on Solana Explorer.</p>
            </li>
          </ul>
        </div>
        <div className={`panel ${styles.diagramPanel}`}>
          <LanesDiagram />
        </div>
      </div>
    </section>
  );
}
