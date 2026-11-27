"use client";

import { nextStakePayout } from "@cato/shared";
import type { StakingStats as Stats } from "../../hooks/useStakingStats";
import { formatCato } from "../../lib/stakingMath";
import {
  PAYOUT_UTC_LABEL,
  formatAgo,
  formatCountdown,
  formatLocalClock,
  localZoneName,
  useNow,
} from "../../lib/localTime";
import { Ticker } from "../Ticker";
import s from "./staking.module.css";

const whole = (n: number) => Math.round(n).toLocaleString("en-US");

export function StakingStats({ stats, error }: { stats: Stats | null; error: boolean }) {
  const pending = error ? "–" : "…";
  const now = useNow(1000);
  const next = now ? nextStakePayout(now) : null;

  return (
    <div className={s.poolStats} aria-live="polite">
      <div className={s.apy}>
        <span className={s.apyLabel}>Estimated APY</span>
        <span className={s.apyValue}>
          {stats ? (stats.apy != null ? `${whole(stats.apy)}%` : "–") : pending}
        </span>
        <span className={s.apyNote}>
          {formatCato(stats?.dailyReward ?? 0)} <Ticker /> is paid out every day, split by stake
        </span>
      </div>

      <dl className={s.stats}>
        <div>
          <dt>Total staked</dt>
          <dd>{stats ? <>{whole(stats.totalStaked)} <Ticker /></> : pending}</dd>
        </div>
        <div>
          <dt>Stakers</dt>
          <dd>{stats ? whole(stats.stakers) : pending}</dd>
        </div>
        <div>
          <dt>Rewards paid so far</dt>
          <dd>{stats ? <>{whole(stats.rewardsDistributed)} <Ticker /></> : pending}</dd>
        </div>
      </dl>

      <div className={s.payout}>
        <div className={s.payoutMain}>
          <span className={s.payoutLabel}>Next payout in</span>
          <span className={s.payoutValue} aria-live="off">
            {now && next ? formatCountdown(next.getTime() - now.getTime()) : "…"}
          </span>
        </div>
        <p className={s.payoutMeta}>
          {now && next ? (
            <>
              Every day at {formatLocalClock(next)} {localZoneName(next)} ({PAYOUT_UTC_LABEL})
              {stats?.lastPayoutAt && (
                <>
                  <br />
                  Last payout {formatAgo(stats.lastPayoutAt, now)}
                </>
              )}
            </>
          ) : (
            <>Every day at {PAYOUT_UTC_LABEL}</>
          )}
        </p>
      </div>
    </div>
  );
}
