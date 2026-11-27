"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { clawAnalyticsUrl } from "./analyticsPrivacy";

function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  if (event.type !== "pageview") return null;
  const url = clawAnalyticsUrl(event.url);
  return url ? { ...event, url } : null;
}

export default function ClawAnalytics() {
  return <Analytics beforeSend={beforeSend} debug={false} />;
}
