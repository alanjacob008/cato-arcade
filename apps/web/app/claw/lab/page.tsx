import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ClawArcade from "../../../components/claw/ClawArcade";

export const metadata: Metadata = {
  title: "CATO Claw | Internal Lab",
  description: "Internal claw machine tuning and probability testing.",
  robots: { index: false, follow: false },
};

export default function ClawLabPage() {
  // Local diagnostics are unavailable in production; noindex alone is not access control.
  if (process.env.NODE_ENV !== "development") notFound();
  return <ClawArcade mode="lab" />;
}
