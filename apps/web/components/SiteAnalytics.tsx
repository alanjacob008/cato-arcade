"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { clawAnalyticsUrl } from "./claw/analyticsPrivacy";

function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  try {
    const { pathname } = new URL(event.url);
    if (pathname === "/claw" || pathname.startsWith("/claw/")) {
      if (event.type !== "pageview") return null;
      const url = clawAnalyticsUrl(event.url);
      return url ? { ...event, url } : null;
    }
  } catch {
    return null;
  }
  return event;
}

/** Preserve site analytics while excluding claw diagnostics and private URLs. */
export default function SiteAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}
