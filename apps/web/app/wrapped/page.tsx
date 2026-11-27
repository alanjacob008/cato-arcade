import type { Metadata } from "next";
import { WalletGate } from "../../components/WalletGate";

export const metadata: Metadata = {
  title: "Wrapped",
  description: "Unwrap your $CATO year: how long you've held, your bag, and your whole life on Solana.",
};

export default function WrappedHome() {
  return <WalletGate />;
}
