import { notFound } from "next/navigation";
import DevnetClawLab from "../../../components/claw/DevnetClawLab";
import MachineAssetHints from "../../../components/claw/MachineAssetHints";

export const dynamic = "force-dynamic";
export const metadata = { title: "CATO · Rollup VRF timing test", robots: { index: false, follow: false } };

export default function RollupClawPage() {
  if (process.env.CLAW_DEVNET_LAB !== "1") notFound();
  return <><MachineAssetHints /><DevnetClawLab execution="er" /></>;
}
