import { NextRequest, NextResponse } from "next/server";
import {
  NONCE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  buildSignInMessage,
  openNonce,
  openSession,
  sealToken,
  sessionSecret,
  vipThreshold,
  type Session,
} from "../../../../lib/updownSession";
import { fetchCatoBalance, isWalletAddress, verifyWalletSignature } from "../../../../lib/updownGate";

export const dynamic = "force-dynamic";

const sessionCookie = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

/** Is this browser signed in? Never reveals more than the wallet it already knows. */
export async function GET(req: NextRequest) {
  const session = await openSession(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json(
    session ? { signedIn: true, wallet: session.wallet } : { signedIn: false },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * Step 2 of sign-in: verify the signature over the message from step 1, then check
 * the live CATO balance. Only a passing wallet gets the session cookie.
 */
export async function POST(req: NextRequest) {
  let body: { wallet?: unknown; signature?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { wallet, signature } = body;
  if (!isWalletAddress(wallet) || typeof signature !== "string") {
    return NextResponse.json({ error: "Invalid wallet or signature." }, { status: 400 });
  }
  const nonce = await openNonce(req.cookies.get(NONCE_COOKIE)?.value);
  if (!nonce || nonce.wallet !== wallet || nonce.domain !== req.nextUrl.host) {
    return NextResponse.json({ error: "Sign-in expired. Please try again." }, { status: 400 });
  }
  const message = buildSignInMessage(nonce.domain, wallet, nonce.nonce, nonce.issuedAt);
  if (!verifyWalletSignature(wallet, message, signature)) {
    return NextResponse.json({ error: "That signature does not match this wallet." }, { status: 401 });
  }

  let balance: number;
  try {
    balance = await fetchCatoBalance(wallet);
  } catch {
    return NextResponse.json({ error: "Could not check your CATO balance. Please try again." }, { status: 502 });
  }
  const threshold = vipThreshold();
  const clearNonce = (res: NextResponse) => {
    res.cookies.set(NONCE_COOKIE, "", { ...sessionCookie, path: "/api/updown", maxAge: 0 });
    return res;
  };
  if (balance < threshold) {
    return clearNonce(NextResponse.json({ ok: false, reason: "not_vip", balance, threshold }, { status: 403 }));
  }
  const session: Session = { wallet, balance, exp: Date.now() + SESSION_TTL_MS };
  const res = NextResponse.json({ ok: true, balance, threshold });
  res.cookies.set(SESSION_COOKIE, await sealToken(session, sessionSecret(), "session"), {
    ...sessionCookie,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return clearNonce(res);
}

/** Sign out of the beta (the wallet stays connected on the site). */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookie, maxAge: 0 });
  return res;
}
