import { NextResponse } from "next/server";

/** Target of next.config's rewrite for a /updown/assets/* file that does not exist. */
export const dynamic = "force-dynamic";

export function GET() {
  return new NextResponse("Not found.", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}
export const HEAD = GET;
