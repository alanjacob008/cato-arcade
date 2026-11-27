import type { Metadata } from "next";
import Link from "next/link";
import { fetchShare } from "../../../lib/api";
import { buildCollectibleCard, fallbackCollectible, shareTweetUrl, type CollectibleCard } from "../../../lib/shareModel";
import { buildShareMetadata } from "../../../lib/metadata";
import { Ticker } from "../../../components/Ticker";
import { CatPerch } from "../../../components/cat/CatPerch";
import st from "../../../components/staking/staking.module.css";
import w from "../../../components/wrapped/wrapped.module.css";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

type ShareParams = { params: Promise<{ wallet: string }> };

export async function generateMetadata({ params }: ShareParams): Promise<Metadata> {
  const { wallet } = await params;
  try {
    const data = await fetchShare(wallet);
    const m = buildShareMetadata(data, SITE);
    return { title: { absolute: m.title }, description: m.description, openGraph: m.openGraph, twitter: m.twitter };
  } catch {
    return { title: "Wrapped card" };
  }
}

export default async function SharePage({ params }: ShareParams) {
  const { wallet } = await params;
  let card: CollectibleCard;
  try {
    card = buildCollectibleCard(await fetchShare(wallet));
  } catch {
    card = fallbackCollectible();
  }

  const pageUrl = `${SITE}/w/${wallet}`;
  const tweetUrl = shareTweetUrl(card, pageUrl);
  const imageUrl = `/w/${wallet}/opengraph-image`;

  return (
    // st.page supplies the --cat and --perch sizing the cat perch relies on.
    <main className={`${st.page} ${w.root}`} style={{ display: "block", minHeight: 0 }}>
      <div className={w.sharePage}>
        <div className={w.shareStage}>
          <CatPerch pose="celebrate" line="Look at you. Frame this one." />
          <section className={w.shareCard} aria-label="Your $CATO Wrapped card">
            <span className={w.tier}>{card.tier}</span>
            <h1 className={w.shareTitle}>
              <Ticker /> Wrapped
            </h1>
            {card.wallet && <span className={w.walletChip}>{card.wallet}</span>}

            {card.stats.length > 0 ? (
              <dl className={w.shareStats}>
                {card.stats.map((s, i) => (
                  <div key={i}>
                    <dt>{s.label}</dt>
                    <dd>{s.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className={w.sub} style={{ marginTop: 20, fontSize: 16 }}>
                Couldn&apos;t load this wallet&apos;s card.
              </p>
            )}

            {card.untouchedAirdrop && <p className={w.shareNote}>Untouched OG airdrop</p>}
          </section>
        </div>

        <div className={w.actions} style={{ marginTop: 24 }}>
          <a href={tweetUrl} target="_blank" rel="noopener noreferrer" className={w.primaryBtn}>
            Share on X
          </a>
          <a href={imageUrl} download="cato-wrapped.png" className={w.secondaryBtn}>
            Download image
          </a>
        </div>

        <p style={{ marginTop: 24 }}>
          <Link href={`/wrapped/${wallet}`} className={w.textLink}>
            See the full story
          </Link>
        </p>
      </div>
    </main>
  );
}
