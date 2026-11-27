import type { Metadata } from "next";
import { Reveal } from "../../../components/Reveal";

export const metadata: Metadata = {
  title: "Wrapped",
  description: "A $CATO Wrapped story: loyalty, bag, rank and a whole life on Solana.",
};

export default async function WrappedPage({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  return <Reveal wallet={wallet} />;
}
