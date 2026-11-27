import type { Metadata } from "next";
import Link from "next/link";
import { CatPerch } from "../../../components/cat/CatPerch";
import st from "../../../components/staking/staking.module.css";
import w from "../../../components/wrapped/wrapped.module.css";

export const metadata: Metadata = {
  title: "Up Down",
  description: "Up Down is coming online soon.",
};

/**
 * Shown at /updown only when a production build has no game bundle in
 * public/updown (scripts/build-updown.mjs skipped or unavailable). With the
 * bundle, next.config.mjs rewrites /updown to its index.html before this page is
 * reached, so players never see it. middleware.ts still gates the path, so only
 * signed-in VIPs land here.
 */
export default function UpDownComingSoon() {
  return (
    <main className={`${st.page} ${w.root}`}>
      <div className={`${st.intro} ${w.introCentered}`}>
        <header className={st.hero}>
          <h1>Up Down is coming online soon.</h1>
          <p>You are on the list. The game is warming up; check back shortly.</p>
        </header>
      </div>

      <div className={st.action}>
        <div className={st.stage}>
          <CatPerch pose="waking" line="Still stretching. Give me a minute." />
          <section className={st.card} aria-label="Up Down status">
            <div className={st.cardBody}>
              <h2 className={st.lockedTitle}>Almost ready</h2>
              <p className={st.lockedCopy}>
                Up Down is not open yet. Nothing has been traded and nothing is needed from your wallet.
                Your VIP sign-in stays valid, so you can come straight back.
              </p>
              <Link href="/staking" className={st.primary} style={{ textAlign: "center", textDecoration: "none" }}>
                Back to staking
              </Link>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
