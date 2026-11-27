"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchGate } from "../lib/api";
import { isValidWalletOrDomain, isSolDomain } from "../lib/walletValidation";
import { Ticker } from "./Ticker";
import { CatPerch } from "./cat/CatPerch";
import { catPoseSrc, type CatPose } from "./cat/catPose";
// Shared page layout (grid, hero, card, button) from the staking page.
import st from "./staking/staking.module.css";
import w from "./wrapped/wrapped.module.css";
export function WalletGate() {
  const [wallet, setWallet] = useState("");
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  useEffect(() => {
    for (const pose of ["alert", "waiting", "confused"] as const) {
      const img = new window.Image();
      img.src = catPoseSrc(pose);
    }
  }, []);

  async function check() {
    setError(null);
    const value = wallet.trim();
    if (!isValidWalletOrDomain(value)) {
      setError("Enter a Solana wallet address or a .sol domain.");
      return;
    }
    setLoading(true);
    try {
      // Everyone gets a report. The gate endpoint still resolves .sol domains
      // to an owner and logs the search.
      const res = await fetchGate(value);
      router.push(`/wrapped/${res.wallet ?? value}`);
    } catch {
      setError(
        isSolDomain(value)
          ? "Couldn't resolve that .sol domain. Check the spelling and try again."
          : "Couldn't reach the server. Please try again.",
      );
      setLoading(false);
    }
  }

  const typing = focused || wallet.trim().length > 0;
  const pose: CatPose = loading ? "waiting" : error ? "confused" : typing ? "alert" : "asleep";
  const line = loading
    ? "Digging through your history. One moment."
    : error
      ? "Hmm, I couldn't find that one."
      : typing
        ? "Ooh, whose year are we unwrapping?"
        : "Zzz… paste a wallet and I'll wake up.";

  return (
    <main className={`${st.page} ${w.root}`}>
      <div className={`${st.intro} ${w.introCentered}`}>
        <header className={st.hero}>
          <h1>
            Unwrap your <Ticker /> year
          </h1>
          <p>
            Paste any Solana wallet or .sol domain to see your <Ticker /> story and your
            whole life on Solana. Holder or not, you get a report.
          </p>
        </header>
      </div>

      <div className={st.action}>
        <div className={st.stage}>
          <CatPerch pose={pose} line={line} />
          <section className={st.card} aria-label="Unwrap a wallet">
            <h2 className={st.lockedTitle}>Whose year is it?</h2>
            <p className={st.lockedCopy}>
              Paste a wallet address or a .sol domain. Nothing to connect or sign.
            </p>
            <div className={w.walletField}>
              <input
                value={wallet}
                onChange={(e) => {
                  setWallet(e.target.value);
                  if (error) setError(null);
                }}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onKeyDown={(e) => e.key === "Enter" && !loading && check()}
                placeholder="Wallet address or name.sol"
                aria-label="Solana wallet address or .sol domain"
                aria-invalid={Boolean(error)}
                aria-describedby="wallet-error"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <p id="wallet-error" className={w.formError} role="alert">
              {error}
            </p>
            <button type="button" className={st.primary} onClick={check} disabled={loading}>
              {loading ? "Unwrapping…" : "Unwrap"}
            </button>
            <p className={w.hint}>
              Your report covers your <Ticker /> history and your activity across Solana.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
