"use client";

import Link from "next/link";
import type { AcquisitionType } from "@cato/shared";
import { formatUsd, shortWallet, topPercentLabel } from "../../lib/shareModel";
import { useCountUp } from "../../hooks/useCountUp";
import { ActivityCalendar } from "../ActivityCalendar";
import { Ticker } from "../Ticker";
import { catPoseSrc, type CatPose } from "../cat/catPose";
import type {
  BagScene as BagSceneT,
  CalendarScene as CalendarSceneT,
  ConvictionScene as ConvictionSceneT,
  IntroScene as IntroSceneT,
  OgTimelineScene as OgTimelineSceneT,
  RankScene as RankSceneT,
  Scene,
  SolanaLifeScene as SolanaLifeSceneT,
  ShareScene as ShareSceneT,
} from "../../lib/wrappedModel";
import w from "./wrapped.module.css";

// ── shared bits ─────────────────────────────────────────────────────────────

const ACQUISITION: Record<AcquisitionType, string> = {
  bought: "you bought it on a DEX",
  airdropped: "it was airdropped to you",
  received: "someone sent it to you",
  unknown: "however the cat dragged you in",
};

/** "1,260" → "3 yrs, 5 mos, 12 days" (approximate, friendly). */
function humanizeDays(days: number): string {
  const years = Math.floor(days / 365);
  const months = Math.floor((days % 365) / 30);
  const rest = (days % 365) % 30;
  const parts: string[] = [];
  if (years) parts.push(`${years} yr${years > 1 ? "s" : ""}`);
  if (months) parts.push(`${months} mo${months > 1 ? "s" : ""}`);
  if (rest || parts.length === 0) parts.push(`${rest} day${rest === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function utcParts(iso: string): { mon: string; monthName: string; year: number; day: number } {
  const d = new Date(iso);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return {
    mon,
    monthName: d.toLocaleString("en-US", { month: "long", timeZone: "UTC" }),
    year: d.getUTCFullYear(),
    day: d.getUTCDate(),
  };
}

const whole = (n: number) => Math.round(n).toLocaleString("en-US");

/** A cat pose above a scene's headline. */
function SceneCat({ pose }: { pose: CatPose }) {
  return <img src={catPoseSrc(pose)} alt="" width={1080} height={1320} className={w.sceneCat} />;
}

// ── scenes ───────────────────────────────────────────────────────────────────

function IntroScene({ scene }: { scene: IntroSceneT }) {
  const since = scene.firstTxIso ? utcParts(scene.firstTxIso) : null;
  // A wallet holding zero $CATO still gets the report, with a playful tease.
  if (scene.holdsNone) {
    return (
      <>
        <SceneCat pose="confused" />
        <p className={w.kicker}>
          <Ticker /> Wrapped
        </p>
        <h1 className={`${w.big} ${w.bigMid}`}>
          Not a single <Ticker />?
        </h1>
        <p className={w.sub}>Bold of you to check. Here&apos;s your Solana year anyway.</p>
      </>
    );
  }
  if (scene.archetype === "newcomer") {
    return (
      <>
        <SceneCat pose="waking" />
        <p className={w.kicker}>
          <Ticker /> Wrapped
        </p>
        <h1 className={`${w.big} ${w.bigMid}`}>Welcome to the colony</h1>
        <p className={w.sub}>You&apos;re a cat now. Here&apos;s your story on Solana so far.</p>
      </>
    );
  }
  return (
    <>
      <SceneCat pose="alert" />
      <p className={w.kicker}>
        <Ticker /> Wrapped
      </p>
      <h1 className={`${w.big} ${w.bigMid}`}>
        {since ? (
          <>
            You&apos;ve been a cat since
            <br />
            <span className={w.accent}>
              {since.monthName} {since.year}
            </span>
          </>
        ) : (
          <>
            Let&apos;s unwrap your <Ticker /> year
          </>
        )}
      </h1>
      <p className={w.sub}>Scroll to relive it.</p>
    </>
  );
}

function OgTimelineScene({ scene, inView }: { scene: OgTimelineSceneT; inView: boolean }) {
  const { mon, year, day } = utcParts(scene.firstTxIso);
  const days = Math.round(useCountUp(scene.holdDays, { play: inView }));

  // Position the holder's first $CATO on the genesis → today timeline.
  const genesisMs = Date.parse(`${scene.genesisIso}T00:00:00Z`);
  const firstMs = Date.parse(scene.firstTxIso);
  const nowMs = Date.now();
  const joinPct = Math.min(100, Math.max(0, ((firstMs - genesisMs) / (nowMs - genesisMs)) * 100));

  return (
    <>
      <p className={w.kicker}>Loyalty and OG status</p>

      <div className={w.calendarPage}>
        <span>
          {mon} {year}
        </span>
        <strong>{day}</strong>
      </div>

      <h2 className={w.big}>
        {days.toLocaleString()} <span className={w.accent}>days</span>
      </h2>
      <p className={w.sub}>
        holding <Ticker />. That&apos;s {humanizeDays(scene.holdDays)}.
      </p>

      <div style={{ margin: "28px auto 0", maxWidth: 560 }}>
        <div className={w.bar}>
          <div className={w.barFill} style={{ left: `${joinPct}%`, right: 0 }} />
          <div className={w.barMarker} title="You joined" style={{ left: `${joinPct}%` }} />
        </div>
        <div className={w.barLegend}>
          <span>
            <Ticker /> was born, May 2021
          </span>
          <span>Today</span>
        </div>
      </div>

      {scene.pctLoyalty !== null && (
        <p className={w.sub} style={{ marginTop: 22 }}>
          More loyal than <strong>{scene.pctLoyalty.toFixed(0)}%</strong> of all cats.
        </p>
      )}
    </>
  );
}

function BagScene({ scene, inView }: { scene: BagSceneT; inView: boolean }) {
  const bal = Math.round(useCountUp(scene.balance, { play: inView }));
  const usd = formatUsd(scene.bagUsd);
  return (
    <>
      <SceneCat pose="guarding" />
      <p className={w.kicker}>Your bag</p>
      <h2 className={w.big}>{bal.toLocaleString()}</h2>
      <p className={w.sub} style={{ color: "var(--fg)", fontWeight: 600, fontSize: "clamp(20px, 3vw, 28px)" }}>
        <Ticker />
      </p>
      {usd && (
        <p className={w.sub} style={{ marginTop: 10 }}>
          worth about <span className={w.accent}>{usd}</span> today
        </p>
      )}
    </>
  );
}

function ConvictionScene({ scene }: { scene: ConvictionSceneT }) {
  const total = scene.totalBought + scene.totalSold;
  const heldPct = total > 0 ? Math.round((scene.totalBought / total) * 100) : 100;
  return (
    <>
      {scene.untouchedAirdrop && <SceneCat pose="celebrate" />}
      <p className={w.kicker}>Diamond paws</p>
      {scene.untouchedAirdrop ? (
        <>
          <h2 className={`${w.big} ${w.bigMid}`}>Untouched OG airdrop</h2>
          <p className={w.sub}>
            You never sold a single coin of your original 19,417 <Ticker />. Legend.
          </p>
        </>
      ) : (
        <>
          <h2 className={w.big}>{whole(Math.max(0, scene.net))}</h2>
          <p className={w.sub}>
            net <Ticker /> accumulated.
          </p>
        </>
      )}

      {scene.totalSold > 0 && (
        <div style={{ margin: "28px auto 0", maxWidth: 520 }}>
          <div className={w.bar} style={{ height: 14, overflow: "hidden" }}>
            <div className={w.barFill} style={{ left: 0, width: `${heldPct}%`, borderRadius: 0 }} />
          </div>
          <div className={w.barLegend}>
            <span>
              Bought {whole(scene.totalBought)} <Ticker />
            </span>
            <span>
              Sold {whole(scene.totalSold)} <Ticker />
            </span>
          </div>
        </div>
      )}
      <p className={w.sub} style={{ marginTop: 20, fontSize: 16 }}>
        How you got in: {ACQUISITION[scene.acquisitionType]}.
      </p>
    </>
  );
}

function RankScene({ scene }: { scene: RankSceneT }) {
  const top = topPercentLabel(scene.pctBalance);
  return (
    <>
      <SceneCat pose="celebrate" />
      <p className={w.kicker}>Where you rank</p>
      {scene.rankLongest !== null ? (
        <>
          <h2 className={w.big}>#{scene.rankLongest.toLocaleString()}</h2>
          <p className={w.sub}>longest-holding cat of all time.</p>
        </>
      ) : top ? (
        <h2 className={`${w.big} ${w.bigMid}`}>{top}</h2>
      ) : null}

      <div className={w.chips}>
        {scene.rankLongest !== null && top && <span className={w.chip}>{top}</span>}
        {scene.pctLoyalty !== null && (
          <span className={w.chip}>More loyal than {scene.pctLoyalty.toFixed(0)}% of cats</span>
        )}
      </div>
    </>
  );
}

function SolanaLifeScene({ scene, inView }: { scene: SolanaLifeSceneT; inView: boolean }) {
  const year = scene.firstTxMs !== null ? new Date(scene.firstTxMs).getUTCFullYear() : null;
  const txs = Math.round(useCountUp(scene.totalTxCount, { play: inView }));
  const txLabel = `${txs.toLocaleString()}${scene.capped ? "+" : ""}`;
  return (
    <>
      <p className={w.kicker}>Your life on Solana</p>
      {year !== null ? (
        <h2 className={w.big}>
          Since <span className={w.accent}>{year}</span>
        </h2>
      ) : (
        <h2 className={w.big}>{txLabel}</h2>
      )}
      <p className={w.sub}>{year !== null ? `${txLabel} transactions and counting.` : "transactions on Solana."}</p>

      <dl className={w.statRow}>
        <div>
          <dt>Active days</dt>
          <dd>{scene.activeDays.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Tokens touched</dt>
          <dd>{scene.distinctTokens.toLocaleString()}</dd>
        </div>
        <div>
          <dt>NFT actions</dt>
          <dd>{scene.nftCount.toLocaleString()}</dd>
        </div>
        {scene.walletAgeDays !== null && (
          <div>
            <dt>Wallet age</dt>
            <dd>{scene.walletAgeDays.toLocaleString()} days</dd>
          </div>
        )}
      </dl>

      {scene.programsUsed.length > 0 && (
        <div className={w.chips}>
          {scene.programsUsed.slice(0, 6).map((p) => (
            <span key={p} className={w.chip}>
              {p.charAt(0) + p.slice(1).toLowerCase()}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function CalendarScene({ scene }: { scene: CalendarSceneT }) {
  return (
    <div style={{ width: "100%", maxWidth: 760, margin: "0 auto", textAlign: "left" }}>
      <h2 className={`${w.big} ${w.bigSmall}`} style={{ textAlign: "center", marginBottom: 24 }}>
        Every day you showed up
      </h2>
      <ActivityCalendar txByDay={scene.txByDay} />
    </div>
  );
}

function ShareScene({ scene }: { scene: ShareSceneT }) {
  return (
    <>
      <SceneCat pose={scene.holdsNone ? "wave" : "celebrate"} />
      <p className={w.kicker}>That&apos;s a wrap</p>
      <h2 className={`${w.big} ${w.bigMid}`}>
        {scene.holdsNone ? (
          "Now go become a cat"
        ) : (
          <>
            That&apos;s your <Ticker /> year
          </>
        )}
      </h2>
      {scene.untouchedAirdrop && <p className={w.sub}>Untouched OG airdrop holder.</p>}
      {scene.holdsNone && (
        <p className={w.sub}>
          You don&apos;t hold any <Ticker /> yet. Easy to fix.
        </p>
      )}
      <span className={w.walletChip} style={{ margin: "14px 0 28px" }}>
        {shortWallet(scene.wallet)}
      </span>

      <div className={w.actions}>
        {scene.holdsNone ? (
          <Link href="/swap" className={w.primaryBtn}>
            Swap into <Ticker />
          </Link>
        ) : (
          <Link href="/" className={w.primaryBtn}>
            Stake your <Ticker />
          </Link>
        )}
        <Link href={`/w/${scene.wallet}`} className={w.secondaryBtn}>
          Get your shareable card
        </Link>
      </div>
    </>
  );
}

/** Map a scene descriptor to its bespoke body (discriminated-union narrowed). */
export function SceneView({ scene, inView }: { scene: Scene; inView: boolean }) {
  switch (scene.kind) {
    case "intro":
      return <IntroScene scene={scene} />;
    case "ogTimeline":
      return <OgTimelineScene scene={scene} inView={inView} />;
    case "bag":
      return <BagScene scene={scene} inView={inView} />;
    case "conviction":
      return <ConvictionScene scene={scene} />;
    case "rank":
      return <RankScene scene={scene} />;
    case "solanaLife":
      return <SolanaLifeScene scene={scene} inView={inView} />;
    case "calendar":
      return <CalendarScene scene={scene} />;
    case "share":
      return <ShareScene scene={scene} />;
  }
}
