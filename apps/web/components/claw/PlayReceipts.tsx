import { HiOutlineTicket } from "react-icons/hi2";
import type { ClubReceipt } from "./clubCosmetics";
import type { PullResult } from "./rewards";
import { TOKEN_TYPES } from "./tokens";
import { vrfExplorerLink, type VrfExecution } from "./vrfExplorer";
import styles from "./player.module.css";
import shell from "./arcadeShell.module.css";
import tickets from "./receiptTickets.module.css";

export type PlayReceipt = ClubReceipt & { vrf?: {
  targetId: string | null; source: PullResult["source"];
  requestSignature: string | null; callbackSignature: string | null;
} };

const amount = (cents: number) => (cents / 100).toFixed(2);
const prize = (cents: number) => cents % 100 ? amount(cents) : String(cents / 100);
const net = (cents: number) => `${cents < 0 ? "−" : cents > 0 ? "+" : ""}${amount(Math.abs(cents))}`;

export default function PlayReceipts({ receipts, devnet = false, execution, freeTest = false }: {
  receipts: readonly PlayReceipt[]; devnet?: boolean; execution?: VrfExecution; freeTest?: boolean;
}) {
  const latest = receipts.slice(0, 50), currency = devnet ? freeTest ? "test USDC" : "devnet USDC" : "USDC";
  return <>
    <p className={styles.dialogIntro}>{devnet ? `Latest 50 completed plays · Devnet${execution === "er" ? " · MagicBlock ER" : ""}` : "Your latest 50 completed local plays. Buying unused tokens does not count as spending on a play."}</p>
    {latest.length ? <div className={`${styles.receiptScroll} ${tickets.scroll}`}>
      <ol className={tickets.list}>{latest.map((receipt, index) => {
        const proof = receipt.vrf;
        const request = vrfExplorerLink(proof?.requestSignature, execution), callback = vrfExplorerLink(proof?.callbackSignature, execution);
        const noTarget = proof?.targetId === null && !proof.requestSignature && !proof.callbackSignature;
        const verified = proof?.source === "magicblock-vrf" && !!request && !!callback;
        return <li className={tickets.ticket} key={receipt.id}>
          <div className={tickets.body}>
            <div className={tickets.heading}><strong>{TOKEN_TYPES[receipt.tier].name}</strong>
              <dl className={tickets.details}>
                <div><dt>{freeTest ? "Token value" : "Entry"}</dt><dd>{prize(receipt.entryCents)} {currency}</dd></div>
                {!devnet && <div><dt>Net</dt><dd>{net(receipt.netCents)} USDC</dd></div>}
              </dl>
            </div>
            {devnet && <div className={tickets.proofRow}>
              <span className={tickets.proof} data-verified={verified}>{noTarget ? "No target · no VRF request" : verified ? "Verified VRF" : "VRF receipt unavailable"}</span>
              {(request || callback) && <div className={tickets.links}>
                {request && <a href={request} target="_blank" rel="noopener noreferrer" aria-label={`View VRF request for play ${index + 1} (opens in new tab)`}>Request<span aria-hidden="true">↗</span></a>}
                {callback && <a href={callback} target="_blank" rel="noopener noreferrer" aria-label={`View VRF callback for play ${index + 1} (opens in new tab)`}>Callback<span aria-hidden="true">↗</span></a>}
              </div>}
            </div>}
            <code className={tickets.serial} title={receipt.id} aria-label={`Play ID ${receipt.id}`}>{receipt.id}</code>
          </div>
          <div className={tickets.stub} data-win={receipt.prizeCents > 0}>
            <span>PRIZE</span><strong>{receipt.prizeCents ? `+${prize(receipt.prizeCents)}` : "MISS"}</strong>
            {receipt.prizeCents > 0 && <span className={tickets.unit}>{currency}</span>}
          </div>
        </li>;
      })}</ol>
      <p className={styles.dialogNote}>{devnet ? execution === "er" ? "Links open MagicBlock’s devnet rollup in Solana Explorer. Choose Connect if it asks to read devnet-as.magicblock.app." : "Links open Solana Explorer on devnet." : "All amounts in USDC. These are local demo receipts."}</p>
    </div> : <div className={`${styles.emptyState} ${shell.empty}`}><HiOutlineTicket /><strong>No completed plays yet.</strong><p>{devnet ? "Your VRF receipts will appear here after a play." : "Your completed plays will appear here."}</p></div>}
  </>;
}
