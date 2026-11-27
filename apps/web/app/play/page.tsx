import type { Metadata } from "next";
import { Suspense } from "react";
import { PlayGate } from "../../components/updown/PlayGate";

export const metadata: Metadata = {
  title: "VIP",
  description: "Something is behind this door. Currently under private beta, only VIPs can access.",
};

export default function PlayPage() {
  // PlayGate reads ?next= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <PlayGate />
    </Suspense>
  );
}
