import { nextStakePayout } from "@cato/shared";
import { DAILY_REWARD_CATO } from "../../hooks/useStakingStats";
import { PAYOUT_UTC_LABEL, formatLocalClock, localZoneName } from "../../lib/localTime";

export type FaqEntry = { id: string; q: string; a: string };

// Every answer is checked against the deployed stake-rewards program
// (DEM7gtr1..., stake-rewards-program commit a16801f) and the backend reward
// crons in apps/api/src/services/staking. Keep them in sync if either changes.
/** FAQ with times shown in the reader's own timezone. Call on the client. */
export function getFaq(now: Date = new Date()): FaqEntry[] {
  const next = nextStakePayout(now);
  const local = `${formatLocalClock(next)} ${localZoneName(next)}`;
  return FAQ_ENTRIES.map((f) =>
    f.id === "when"
      ? {
          ...f,
          a: `Once a day, at ${PAYOUT_UTC_LABEL}. That's ${local} where you are. New stake joins the split once it has been in for about 22 hours, so it starts earning from its first or second payout.`,
        }
      : f,
  );
}

const FAQ_ENTRIES: FaqEntry[] = [
  {
    id: "how",
    // distribute: floor(stake * vaultBalance / total_staked); leftovers stay in the vault.
    q: "How are rewards worked out?",
    a: `Every day about ${DAILY_REWARD_CATO} $CATO is shared between stakers by the size of their stake. Hold 10% of the $CATO that's earning and you get about 10% of the day's payout. Any part of the pool that isn't paid out rolls into the next day.`,
  },
  {
    id: "when",
    // Crons: STAKE_SEND_REVENUE_UTC then STAKE_PAYOUT_UTC (19:30 UTC). Warm-up 80,000 s.
    q: "When are rewards paid out?",
    a: `Once a day, at ${PAYOUT_UTC_LABEL}. New stake joins the split once it has been in for about 22 hours, so it starts earning from its first or second payout.`,
  },
  {
    id: "topup",
    // deposit overwrites last_deposited_at/amount only; older stake stays eligible.
    q: "Does adding more reset my rewards?",
    a: "No. The $CATO you already had staked keeps earning as usual. Only the amount you just added waits about 22 hours before it joins the split.",
  },
  {
    id: "withdraw",
    // withdraw: amount <= deposited - withdrawn, no lock, earned untouched.
    q: "Can I withdraw whenever I want?",
    a: "Yes. There's no lock-up and no fee, so you can withdraw some or all of your stake at any time, even right after staking. Rewards you've already earned stay ready to claim.",
  },
  {
    id: "claim",
    // claim: min(earned - claimed, reward account balance), any time, stake untouched.
    q: "Do I have to claim my rewards?",
    a: "Your rewards are set aside for you after each payout and wait until you claim them. Claim whenever you like, there's no minimum. Claiming sends them to your wallet and doesn't touch your stake.",
  },
  {
    id: "apy",
    q: "Is the APY fixed?",
    a: "No, it's an estimate. It takes the daily payout times 365 and divides it by all the $CATO that's earning right now. When more $CATO is staked, everyone's share and the APY go down.",
  },
  {
    id: "cost",
    // initialize_user_pda: 96-byte account, rent about 0.0016 SOL, no close instruction.
    q: "What does it cost?",
    a: "Only Solana network fees. Your first stake also creates your staking account, which costs about 0.0016 SOL once. That SOL isn't refunded.",
  },
];
