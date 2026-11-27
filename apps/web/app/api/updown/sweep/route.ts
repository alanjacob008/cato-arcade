import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized, runSweep } from "../../../../lib/updownSweep";
import { UpdownConfigError, getUpdownRuntime, sweepRefusal, updownEnabled } from "../../../../lib/updownRuntime";

/**
 * Vercel Cron (vercel.json, every minute): close due Up Down rounds even when no
 * player has the game open. Outside middleware.ts's gate; authenticated with
 * `Authorization: Bearer ${CRON_SECRET}` instead. See lib/updownSweep.ts.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Must equal SWEEP_MAX_DURATION_S in lib/updownSweep.ts (Next needs a literal here).
// The loop starts passes for ~55s and no new round after 75s, leaving 45s for
// the slowest round in flight.
export const maxDuration = 120;

const noStore = { "Cache-Control": "no-store" };

export async function GET(req: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) {
    return NextResponse.json({ error: "CRON_SECRET is not set." }, { status: 503, headers: noStore });
  }
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: noStore });
  }
  // A deployment that serves no game and has no database has nothing to sweep.
  if (!process.env.DATABASE_URL?.trim() && !updownEnabled()) {
    return NextResponse.json({ ok: true, skipped: "Up Down is not enabled on this deployment." }, { headers: noStore });
  }
  // Preview deployments never act on rounds (they could be Production's) unless opted in.
  const refusal = sweepRefusal();
  if (refusal) return NextResponse.json({ error: refusal }, { status: 503, headers: noStore });
  try {
    const { sweeper, store } = await getUpdownRuntime();
    const result = await runSweep({ engine: sweeper, store });
    return NextResponse.json({ ok: true, ...result }, { headers: noStore });
  } catch (error) {
    const message = error instanceof UpdownConfigError ? error.message : "Sweep failed.";
    console.error(`Up Down: sweep failed: ${(error as Error)?.message ?? error}`);
    return NextResponse.json({ error: message }, { status: 503, headers: noStore });
  }
}
