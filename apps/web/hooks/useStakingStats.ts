"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { toCato, STAKE_DISTRIBUTION_COOLDOWN_SECONDS } from "@cato/shared";
import { PROGRAM_ID, getCentralVault } from "../lib/program/programData";
import { poolApy } from "../lib/stakingMath";

/**
 * CATO moved into the reward pool each day by the backend's send-revenue cron
 * (STAKE_REVENUE_TRANSFER_CATO, default 100). The program does not store this,
 * so the web app mirrors it to estimate APY.
 */
export const DAILY_REWARD_CATO = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_STAKE_DAILY_REWARD_CATO);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
})();

/** Live UserPda layouts: 80 bytes (no deposit timestamps) and 96 bytes. */
const USER_PDA_SIZES = [8 + 32 + 40, 8 + 32 + 56];

/**
 * Seconds a fresh deposit waits before it counts for rewards. Mirrors
 * DISTRIBUTION_COOLDOWN_SECONDS (80,000 s, about 22 hours) in the deployed
 * stake-rewards program.
 */
export const STAKE_WARMUP_SECONDS = STAKE_DISTRIBUTION_COOLDOWN_SECONDS;

export type StakingStats = {
  totalStaked: number;
  /**
   * Stake that counts at the next payout. Fresh deposits are left out until
   * they have waited STAKE_WARMUP_SECONDS, exactly as the program does.
   */
  earningStaked: number;
  /** Wallets with stake still in the pool. */
  stakers: number;
  /** All rewards ever credited to stakers, claimed or not. */
  rewardsDistributed: number;
  /** Most recent payout to any staker (last_distributed_at), or null. */
  lastPayoutAt: Date | null;
  /** Estimated APY in percent, or null when nothing is earning. */
  apy: number | null;
  dailyReward: number;
};

/**
 * The part of a wallet's stake that earns at the next payout, matching the
 * program's distribute instruction: until the latest deposit has waited the
 * warm-up period, that deposit is left out.
 */
export function earningStake(
  deposited: bigint,
  withdrawn: bigint,
  lastDepositedAt: number,
  lastDepositedAmount: bigint,
  nowSec = Date.now() / 1000,
): bigint {
  const matured = nowSec >= lastDepositedAt + STAKE_WARMUP_SECONDS;
  const v = matured ? deposited - withdrawn : deposited - lastDepositedAmount - withdrawn;
  return v > 0n ? v : 0n;
}

/** Pool-wide stats read straight from the stake-rewards program on chain. */
export function useStakingStats() {
  const { connection } = useConnection();
  const [stats, setStats] = useState<StakingStats | null>(null);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const vault = await connection.getAccountInfo(getCentralVault());
      // PdaAccount: 8 discriminator + 1 bump + u64 total_staked.
      const totalStaked = vault ? toCato(vault.data.readBigUInt64LE(9)) : 0;

      const pages = await Promise.all(
        USER_PDA_SIZES.map((dataSize) =>
          connection.getProgramAccounts(PROGRAM_ID, {
            // Everything after the owner: deposited, withdrawn, earned,
            // claimed, last_distributed_at, then (96-byte layout only)
            // last_deposited_at and last_deposited_amount.
            dataSlice: { offset: 40, length: dataSize - 40 },
            filters: [{ dataSize }],
          }),
        ),
      );

      const now = Date.now() / 1000;
      let stakers = 0;
      let earned = 0n;
      let earning = 0n;
      let lastPayout = 0;
      for (const { account } of pages.flat()) {
        const d = account.data;
        const deposited = d.readBigUInt64LE(0);
        const withdrawn = d.readBigUInt64LE(8);
        if (deposited > withdrawn) stakers += 1;
        earned += d.readBigUInt64LE(16);
        lastPayout = Math.max(lastPayout, Number(d.readBigUInt64LE(32)));
        const hasTimestamps = d.length >= 56;
        earning += earningStake(
          deposited,
          withdrawn,
          hasTimestamps ? Number(d.readBigUInt64LE(40)) : 0,
          hasTimestamps ? d.readBigUInt64LE(48) : 0n,
          now,
        );
      }

      const earningStaked = toCato(earning);
      setStats({
        totalStaked,
        earningStaked,
        stakers,
        rewardsDistributed: toCato(earned),
        lastPayoutAt: lastPayout > 0 ? new Date(lastPayout * 1000) : null,
        apy: poolApy(earningStaked, DAILY_REWARD_CATO),
        dailyReward: DAILY_REWARD_CATO,
      });
      setError(false);
    } catch (e) {
      console.error("staking stats failed", e);
      setError(true);
    }
  }, [connection]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, error, refresh };
}
