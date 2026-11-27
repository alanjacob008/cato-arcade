"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { JupiterSwap } from "../JupiterSwap";
import { Ticker } from "../Ticker";
import { CatPerch, bubbleActionClass } from "../cat/CatPerch";
import { CAT_POSES, catPoseSrc } from "../cat/catPose";
import { useStakingStats } from "../../hooks/useStakingStats";
import { formatUsdCompact, formatUsdPrice, useCatoMarket } from "../../lib/catoMarket";
import { FEE_ENABLED, JUP_FEE_BPS } from "../../lib/swapConfig";
// Shared page layout (grid, hero, big number, stats row, card) from the staking page.
import st from "../staking/staking.module.css";
import s from "./swap.module.css";

const CELEBRATE_MS = 4000;

export function SwapPanel() {
  const { market, error } = useCatoMarket();
  const { stats } = useStakingStats();
  const [justSwapped, setJustSwapped] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    for (const pose of ["alert", "celebrate"] as const) {
      if (!CAT_POSES.includes(pose)) continue;
      const img = new window.Image();
      img.src = catPoseSrc(pose);
    }
    return () => clearTimeout(timer.current);
  }, []);

  const onSwapped = useCallback(() => {
    clearTimeout(timer.current);
    setJustSwapped(true);
    timer.current = setTimeout(() => setJustSwapped(false), CELEBRATE_MS);
  }, []);

  const pending = error ? "–" : "…";
  const change = market?.change24h ?? null;
  const changeDir = change == null ? "flat" : change > 0 ? "up" : change < 0 ? "down" : "flat";

  return (
    <main className={st.page}>
      <div className={st.intro}>
        <header className={st.hero}>
          <h1>
            Swap into <Ticker />
          </h1>
          <p>
            Get <Ticker /> at the best price across Solana. Jupiter finds the route, and
            the swap connects your wallet right inside the card.
          </p>
        </header>

        <div className={st.poolStats} aria-live="polite">
          <div className={st.apy}>
            <span className={st.apyLabel}>
              <Ticker /> price
            </span>
            <span className={`${st.apyValue} ${s.price}`}>
              {market ? formatUsdPrice(market.priceUsd) : pending}
            </span>
            <span className={s.change} data-dir={changeDir}>
              {change == null
                ? "24h change unavailable"
                : `${change > 0 ? "+" : ""}${change.toFixed(2)}% in the last 24 hours`}
            </span>
          </div>

          <dl className={st.stats}>
            <div>
              <dt>Market cap</dt>
              <dd>{market?.marketCapUsd != null ? formatUsdCompact(market.marketCapUsd) : pending}</dd>
            </div>
            <div>
              <dt>Holders</dt>
              <dd>{market?.holders != null ? market.holders.toLocaleString("en-US") : pending}</dd>
            </div>
            <div>
              <dt>24h volume</dt>
              <dd>{market?.volume24hUsd != null ? formatUsdCompact(market.volume24hUsd) : pending}</dd>
            </div>
          </dl>

          <div className={`${st.payout} ${s.earn}`}>
            <div className={st.payoutMain}>
              <span className={st.payoutLabel}>
                Put your <Ticker /> to work
              </span>
              <span className={st.payoutValue}>
                {stats?.apy != null ? `${Math.round(stats.apy).toLocaleString("en-US")}% est. APY` : "Stake and earn daily"}
              </span>
            </div>
            <Link href="/staking" className={s.stakeLink}>
              Stake your <Ticker />
            </Link>
          </div>
        </div>
      </div>

      <div className={st.action}>
        <div className={st.stage}>
          <CatPerch
            pose={justSwapped ? "celebrate" : "alert"}
            line={
              justSwapped
                ? "Welcome to the pride! Stake it and it starts earning."
                : "Swapping in? There's always room in the pride."
            }
            action={
              justSwapped && (
                <Link href="/staking" className={bubbleActionClass}>
                  Go to staking
                </Link>
              )
            }
          />
          <section className={`${st.card} ${s.card}`} aria-label="Swap">
            <JupiterSwap onSwapped={onSwapped} minHeight="var(--swap-min-h, 520px)" />
            <p className={s.note}>
              {FEE_ENABLED
                ? `A ${(JUP_FEE_BPS / 100).toFixed(2)}% fee supports the $CATO community. `
                : ""}
              Prices and routes come from Jupiter. Always check the quote before you swap.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
