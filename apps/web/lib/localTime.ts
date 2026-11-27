"use client";

import { useEffect, useState } from "react";
import { STAKE_PAYOUT_UTC } from "@cato/shared";

/**
 * Current time, ticking every `intervalMs`. Returns null during server render
 * and the first client render, so times always show in the visitor's own
 * timezone without a hydration mismatch.
 */
export function useNow(intervalMs = 1000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "1:00 AM" in the visitor's locale and timezone. */
export function formatLocalClock(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
}

/** Short name of the visitor's timezone, e.g. "GMT+5:30" or "PDT". */
export function localZoneName(d: Date): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "your time";
}

/** The daily payout time in UTC, e.g. "19:30 UTC". */
export const PAYOUT_UTC_LABEL = `${String(STAKE_PAYOUT_UTC.hour).padStart(2, "0")}:${String(
  STAKE_PAYOUT_UTC.minute,
).padStart(2, "0")} UTC`;

/** "6h 48m 12s", dropping leading zero units. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

/** "17 hours ago" in the visitor's language. */
export function formatAgo(then: Date, now: Date): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const sec = Math.round((then.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(sec);
  if (abs < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (abs < 86400 * 2) return rtf.format(Math.round(sec / 3600), "hour");
  return rtf.format(Math.round(sec / 86400), "day");
}
