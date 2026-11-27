"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Ticker } from "../Ticker";
import { CatPerch } from "../cat/CatPerch";
import { type CatPose } from "../cat/catPose";
import st from "../staking/staking.module.css";
import w from "../wrapped/wrapped.module.css";

type Phase =
  | { kind: "checking" }
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "granted" }
  | { kind: "denied"; balance: number; threshold: number }
  | { kind: "error"; message: string };

const GAME_HOME = "/updown";

function gameUrl(next: string | null): string {
  // Only ever send people into the game, never off-site.
  return next && next.startsWith("/updown") ? next : GAME_HOME;
}

function formatCato(n: number): string {
  return `${Math.floor(n).toLocaleString("en-US")} $CATO`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Private-beta door for the Up Down game. Connect a wallet, sign a message to
 * prove it is yours, and the server lets you in if it holds enough CATO.
 */
export function PlayGate() {
  const { publicKey, connected, signMessage, disconnect } = useWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const params = useSearchParams();
  const destination = gameUrl(params?.get("next") ?? null);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  // Already signed in from an earlier visit? Go straight to the game.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/updown/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { signedIn: false }))
      .then((data: { signedIn?: boolean }) => {
        if (cancelled) return;
        if (data.signedIn) {
          setPhase({ kind: "granted" });
          window.location.replace(destination);
        } else {
          setPhase({ kind: "idle" });
        }
      })
      .catch(() => !cancelled && setPhase({ kind: "idle" }));
    return () => {
      cancelled = true;
    };
  }, [destination]);

  const signIn = useCallback(async () => {
    if (!publicKey) return;
    if (!signMessage) {
      setPhase({ kind: "error", message: "This wallet cannot sign messages. Try Phantom or Solflare." });
      return;
    }
    const wallet = publicKey.toBase58();
    setPhase({ kind: "signing" });
    try {
      const nonceRes = await fetch(`/api/updown/nonce?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" });
      if (!nonceRes.ok) throw new Error("Could not start sign-in. Please try again.");
      const { message } = (await nonceRes.json()) as { message: string };
      const signature = await signMessage(new TextEncoder().encode(message));
      const res = await fetch("/api/updown/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, signature: toBase64(signature) }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        balance?: number;
        threshold?: number;
        error?: string;
      };
      if (res.ok && data.ok) {
        setPhase({ kind: "granted" });
        window.location.assign(destination);
        return;
      }
      if (res.status === 403 && data.reason === "not_vip") {
        setPhase({ kind: "denied", balance: data.balance ?? 0, threshold: data.threshold ?? 0 });
        return;
      }
      throw new Error(data.error || "Sign-in failed. Please try again.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Sign-in failed. Please try again.";
      // Wallets throw when the user closes the signature prompt; that is not an error worth shouting about.
      setPhase(/rejected|cancel|denied by user/i.test(message) ? { kind: "idle" } : { kind: "error", message });
    }
  }, [publicKey, signMessage, destination]);

  const switchWallet = useCallback(async () => {
    try {
      await disconnect();
    } finally {
      setPhase({ kind: "idle" });
      openWalletModal(true);
    }
  }, [disconnect, openWalletModal]);

  let pose: CatPose = "guarding";
  let line = "I'm not saying what's back here. Connect a wallet.";
  if (phase.kind === "checking") {
    pose = "waiting";
    line = "Hold on. Have I seen you before?";
  } else if (phase.kind === "signing") {
    pose = "waiting";
    line = "Checking the list…";
  } else if (phase.kind === "granted") {
    pose = "celebrate";
    line = "You're on the list. In you go.";
  } else if (phase.kind === "denied") {
    pose = "guarding";
    line = "Not on the list. Not yet.";
  } else if (phase.kind === "error") {
    pose = "confused";
    line = "Hmm, that didn't work.";
  } else if (connected) {
    pose = "alert";
    line = "Sign in so I know it's really you.";
  }

  return (
    <main className={`${st.page} ${w.root}`}>
      <div className={`${st.intro} ${w.introCentered}`}>
        <header className={st.hero}>
          <h1>Something is behind this door.</h1>
          <p>
            Currently under private beta, only VIPs can access. No hints, no preview. If you know,
            you know.
          </p>
        </header>
      </div>

      <div className={st.action}>
        <div className={st.stage}>
          <CatPerch pose={pose} line={line} />
          <section className={st.card} aria-label="VIP door">
            <div className={st.cardBody}>
              {phase.kind === "denied" ? (
                <>
                  <h2 className={st.lockedTitle}>VIPs only</h2>
                  <p className={st.lockedCopy}>
                    Currently under private beta, only VIPs can access. VIP means holding at least{" "}
                    {formatCato(phase.threshold)} in your wallet. This one holds {formatCato(phase.balance)}.
                    Stack up and come back.
                  </p>
                  <button type="button" className={st.primary} onClick={signIn}>
                    Check again
                  </button>
                  <p className={st.lockedCopy} style={{ marginTop: 16, marginBottom: 0 }}>
                    <button type="button" className={st.linkButton} onClick={switchWallet}>
                      Use a different wallet
                    </button>
                  </p>
                </>
              ) : !connected || !publicKey ? (
                <>
                  <h2 className={st.lockedTitle}>Are you on the list?</h2>
                  <p className={st.lockedCopy}>
                    Connect the Solana wallet that holds your <Ticker />. You will sign one message to
                    prove it is yours. No transaction, no fee.
                  </p>
                  <button
                    type="button"
                    className={st.primary}
                    onClick={() => openWalletModal(true)}
                    disabled={phase.kind === "checking"}
                  >
                    Connect wallet
                  </button>
                </>
              ) : (
                <>
                  <h2 className={st.lockedTitle}>Prove it is you</h2>
                  <p className={st.lockedCopy}>
                    Connected as {shortAddress(publicKey.toBase58())}. Sign a short message to prove this
                    wallet is yours. Nothing is sent on-chain.
                  </p>
                  <button
                    type="button"
                    className={st.primary}
                    onClick={signIn}
                    disabled={phase.kind === "signing" || phase.kind === "granted" || phase.kind === "checking"}
                  >
                    {phase.kind === "signing"
                      ? "Waiting for your wallet…"
                      : phase.kind === "granted"
                        ? "Opening the door…"
                        : "Sign in with wallet"}
                  </button>
                  {phase.kind === "error" && (
                    <p className={st.error} role="alert">
                      {phase.message}
                    </p>
                  )}
                  <p className={st.lockedCopy} style={{ marginTop: 16, marginBottom: 0 }}>
                    <button type="button" className={st.linkButton} onClick={switchWallet}>
                      Use a different wallet
                    </button>
                  </p>
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
