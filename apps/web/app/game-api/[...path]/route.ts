import type { NextRequest } from "next/server";
import { handleGameApi } from "../../../lib/updownGameApi";

/**
 * The Up Down round service: the game's engine and routes (apps/updown/server)
 * running as a serverless function on the website, behind middleware.ts's
 * sign-in gate. Without a built game bundle in a production build it answers
 * 503 "coming online soon". See lib/updownGameApi.ts.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Starting a round makes several sequential Orderly calls (10s timeout each), and a
// poll may advance a round (position read, order lookup, close). Generous, so an
// order is never sent right before the function is cut off (Vercel Pro: up to 800s).
export const maxDuration = 120;

const handle = (req: NextRequest) => handleGameApi(req);

export const GET = handle;
export const POST = handle;
