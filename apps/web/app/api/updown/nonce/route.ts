import { NextRequest, NextResponse } from "next/server";
import {
  NONCE_COOKIE,
  NONCE_TTL_MS,
  buildSignInMessage,
  randomNonce,
  sealToken,
  sessionSecret,
  type Nonce,
} from "../../../../lib/updownSession";
import { isWalletAddress } from "../../../../lib/updownGate";

export const dynamic = "force-dynamic";

/** Step 1 of sign-in: hand the browser a one-time message to sign, remembered in a short-lived cookie. */
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  if (!isWalletAddress(wallet)) {
    return NextResponse.json({ error: "Invalid wallet address." }, { status: 400 });
  }
  const nonce: Nonce = {
    nonce: randomNonce(),
    wallet,
    issuedAt: new Date().toISOString(),
    // The host this request reached (the site), never a value the caller chooses in the body.
    domain: req.nextUrl.host,
    exp: Date.now() + NONCE_TTL_MS,
  };
  const message = buildSignInMessage(nonce.domain, wallet, nonce.nonce, nonce.issuedAt);
  const res = NextResponse.json({ message });
  res.cookies.set(NONCE_COOKIE, await sealToken(nonce, sessionSecret(), "nonce"), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/updown",
    maxAge: Math.floor(NONCE_TTL_MS / 1000),
  });
  return res;
}
