import type { Metadata } from "next";
import ClawArcade from "../../components/claw/ClawArcade";
import MachineAssetHints from "../../components/claw/MachineAssetHints";

export const metadata: Metadata = {
  title: "CATO Arcade | Claw Machine",
  description: "Move the claw, choose your play, and open CATO prize boxes.",
};

export default function ClawPage() {
  return <><MachineAssetHints /><ClawArcade /></>;
}
