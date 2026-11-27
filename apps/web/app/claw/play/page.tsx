import { notFound } from "next/navigation";
import DevnetClawLab from "../../../components/claw/DevnetClawLab";
import MachineAssetHints from "../../../components/claw/MachineAssetHints";

export const dynamic = "force-dynamic";
export const metadata = { title: "CATO Arcade · Devnet preview", robots: { index: false, follow: false } };

export default function RollupPlayerPage() {
  if (process.env.CLAW_DEVNET_LAB !== "1") notFound();
  return <><MachineAssetHints /><DevnetClawLab execution="er" presentation="player" /></>;
}
