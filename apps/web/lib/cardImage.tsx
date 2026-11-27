import { ImageResponse } from "next/og";
import type { ShareData } from "@cato/shared";
import { THEME, buildCollectibleCard, fallbackCollectible, type CollectibleCard } from "./shareModel";

/** 1200×630 — the standard social card size. */
export const CARD_SIZE = { width: 1200, height: 630 };

// Explicit TTF so @vercel/og renders deterministically (the old UA makes Google serve truetype).
let fontPromise: Promise<ArrayBuffer | null> | null = null;
function brandFont(): Promise<ArrayBuffer | null> {
  if (!fontPromise) {
    fontPromise = (async () => {
      try {
        const css = await fetch("https://fonts.googleapis.com/css2?family=Sora:wght@700", {
          headers: { "User-Agent": "Mozilla/4.0" },
        }).then((r) => r.text());
        const url = css.match(/src:\s*url\(([^)]+)\)\s*format\('(truetype|opentype)'\)/)?.[1];
        return url ? await fetch(url).then((r) => r.arrayBuffer()) : null;
      } catch {
        return null;
      }
    })();
  }
  return fontPromise;
}

function CardArt({ card }: { card: CollectibleCard }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: "linear-gradient(135deg, #1A1A1A 0%, #121212 100%)",
        color: THEME.fg,
        fontFamily: "Sora, sans-serif",
        padding: 48,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          border: `2px solid ${THEME.border}`,
          borderRadius: 36,
          padding: "40px 48px",
          background: "radial-gradient(70% 65% at 16% 16%, rgba(254,169,17,0.16), transparent 60%)",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex" }}>
              <div
                style={{
                  display: "flex",
                  background: THEME.accent,
                  color: THEME.espresso,
                  fontSize: 22,
                  fontWeight: 700,
                  padding: "8px 18px",
                  borderRadius: 999,
                  letterSpacing: 2,
                }}
              >
                {card.tier}
              </div>
            </div>
            <div style={{ display: "flex", color: THEME.cream, fontSize: 54, fontWeight: 700, lineHeight: 1.05, marginTop: 20 }}>
              $CATO Wrapped
            </div>
            {card.wallet && <div style={{ display: "flex", color: THEME.muted, fontSize: 24, marginTop: 16 }}>{card.wallet}</div>}
          </div>
          {card.untouchedAirdrop && (
            <div style={{ display: "flex", alignItems: "center", color: THEME.accent, fontSize: 24, fontWeight: 600 }}>
              💎 Untouched OG
            </div>
          )}
        </div>

        {/* stat tiles */}
        <div style={{ display: "flex", flexWrap: "wrap", marginTop: 30, gap: 16 }}>
          {card.stats.map((s, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                width: 320,
                height: 104,
                padding: "0 24px",
                background: "rgba(255,255,255,0.03)",
                border: "1px solid #2a2a2a",
                borderRadius: 20,
              }}
            >
              <div style={{ display: "flex", color: THEME.fg, fontSize: 40, fontWeight: 700 }}>{s.value}</div>
              <div style={{ display: "flex", color: THEME.muted, fontSize: 20, marginTop: 6 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ position: "absolute", bottom: 36, right: 78, display: "flex", fontSize: 24, color: THEME.accent }}>
        the OG cat on Solana
      </div>
    </div>
  );
}

/** Render the collectible card as a 1200×630 PNG (social embed + download). */
export async function renderCollectibleImage(data: ShareData | null): Promise<ImageResponse> {
  const card = data ? buildCollectibleCard(data) : fallbackCollectible();
  const font = await brandFont();
  return new ImageResponse(<CardArt card={card} />, {
    ...CARD_SIZE,
    fonts: font ? [{ name: "Sora", data: font, weight: 700, style: "normal" }] : undefined,
  });
}
