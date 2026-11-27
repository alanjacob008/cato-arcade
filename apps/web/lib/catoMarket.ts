"use client";

import { useEffect, useState } from "react";
import { CATO_MINT } from "./program/catoData";

export type CatoMarket = {
  priceUsd: number;
  /** Percent change over 24 hours, e.g. -0.84. */
  change24h: number | null;
  marketCapUsd: number | null;
  holders: number | null;
  volume24hUsd: number | null;
};

const URL = `https://lite-api.jup.ag/tokens/v2/search?query=${CATO_MINT.toBase58()}`;
const REFRESH_MS = 60_000;

/** Live $CATO market data from Jupiter's token API (the same data the swap widget uses). */
export function useCatoMarket() {
  const [market, setMarket] = useState<CatoMarket | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = (await res.json()) as Array<Record<string, any>>;
        const t = list.find((x) => x?.id === CATO_MINT.toBase58());
        if (!t || typeof t.usdPrice !== "number") throw new Error("CATO not in response");
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
        const s = t.stats24h ?? {};
        const buy = num(s.buyVolume);
        const sell = num(s.sellVolume);
        if (!alive) return;
        setMarket({
          priceUsd: t.usdPrice,
          change24h: num(s.priceChange),
          marketCapUsd: num(t.mcap),
          holders: num(t.holderCount),
          volume24hUsd: buy == null && sell == null ? null : (buy ?? 0) + (sell ?? 0),
        });
        setError(false);
      } catch (e) {
        console.warn("CATO market data failed", e);
        if (alive) setError(true);
      }
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return { market, error };
}

/** $0.000264 style: enough significant digits for a sub-cent token. */
export function formatUsdPrice(p: number): string {
  if (p >= 1) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${p.toPrecision(3).replace(/0+$/, "")}`;
}

/** $76.6K style. */
export function formatUsdCompact(v: number): string {
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v)}`;
}
