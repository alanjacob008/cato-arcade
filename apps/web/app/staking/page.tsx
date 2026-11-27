import type { Metadata } from "next";
import { StakingPanel } from "../../components/staking/StakingPanel";

export const metadata: Metadata = {
  title: "Staking",
  description: "Stake your $CATO, earn rewards.",
};

export default function StakingPage() {
  return <StakingPanel />;
}
