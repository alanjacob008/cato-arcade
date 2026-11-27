import type { Metadata } from "next";
import { SwapPanel } from "../../components/swap/SwapPanel";

export const metadata: Metadata = {
  title: "Swap",
  description: "Swap into $CATO at the best price across Solana, powered by Jupiter.",
};

export default function SwapPage() {
  return <SwapPanel />;
}
