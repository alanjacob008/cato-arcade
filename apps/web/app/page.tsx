import type { Metadata, Viewport } from "next";
import { StakingPanel } from "../components/staking/StakingPanel";
import { ArcadeHero } from "../components/home/ArcadeHero";
import { GrabDrawn } from "../components/home/GrabDrawn";

// The home page opens on the CATO Arcade, then shows how a grab is drawn, then staking as before.
// One <main> holds all three; the staking panel is a section with an h2 here, and /staking renders it on its own
// as that page's <main> with its h1.
export const metadata: Metadata = {
  title: { absolute: "$CATO · CATO Arcade" },
  description: "CATO Arcade: a claw machine on Solana where every grab is drawn by MagicBlock VRF. Play on devnet with free test tokens, or stake $CATO for a share of the daily reward pool.",
  // A shared link shows the arcade's own key art and name.
  openGraph: {
    title: "CATO Arcade: a claw machine on Solana",
    description: "Every grab is drawn by MagicBlock VRF on an Ephemeral Rollup, and the result comes back with its proof. Live on Solana devnet.",
    images: [{ url: "/claw/art/hero-keyart-1280.webp", width: 1280, height: 720, alt: "A steel claw machine full of cream and amber cat boxes, glowing in a dark arcade" }],
  },
  twitter: { card: "summary_large_image" },
};

// The browser chrome takes the arcade's night.
export const viewport: Viewport = { themeColor: "#0B0A09" };

export default function Home() {
  return (
    <main>
      <ArcadeHero />
      <GrabDrawn />
      <StakingPanel embedded />
    </main>
  );
}
