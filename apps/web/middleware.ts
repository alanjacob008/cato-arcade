import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, openSession } from "./lib/updownSession";

/**
 * Private-beta guard for the Up Down game. Everything under /updown (the game
 * bundle) and /game-api (its round service) needs a valid session cookie, which
 * only /api/updown/session issues after a wallet signature and a CATO balance check.
 */
export const config = {
  matcher: ["/updown/:path*", "/game-api/:path*"],
};

/**
 * Cache policy for the served game bundle (public/updown), set here rather than in
 * next.config headers() so it only ever applies to signed-in responses: Vite's
 * hashed assets are immutable; index.html (every client route) and unhashed files
 * revalidate. The sign-in redirect itself is never cacheable.
 */
export function bundleCacheControl(pathname: string): string | null {
  if (!pathname.startsWith("/updown")) return null;
  return pathname.startsWith("/updown/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

export async function middleware(req: NextRequest) {
  const session = await openSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) {
    const res = NextResponse.next();
    const cache = bundleCacheControl(req.nextUrl.pathname);
    if (cache) res.headers.set("Cache-Control", cache);
    return res;
  }

  // Never cacheable: the same URL serves the game once signed in.
  const noStore = { "Cache-Control": "private, no-store" };
  if (req.nextUrl.pathname.startsWith("/game-api")) {
    return NextResponse.json({ error: "Sign in to play." }, { status: 401, headers: noStore });
  }
  const login = req.nextUrl.clone();
  login.pathname = "/play";
  login.search = "";
  const next = req.nextUrl.pathname + req.nextUrl.search;
  if (next !== "/updown/" && next !== "/updown") login.searchParams.set("next", next);
  const res = NextResponse.redirect(login);
  res.headers.set("Cache-Control", noStore["Cache-Control"]);
  return res;
}
