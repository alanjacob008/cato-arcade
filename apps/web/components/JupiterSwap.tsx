"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";
import { recordSwap } from "../lib/api";
import { THEME } from "../lib/shareModel";
import {
  FEE_ENABLED,
  JUP_FEE_BPS,
  JUP_REFERRAL_ACCOUNT,
  SWAP_INPUT_MINT,
  SWAP_OUTPUT_MINT,
} from "../lib/swapConfig";

// Jupiter's hosted loader attaches window.Jupiter. It is mutable third-party code, so
// it loads only where this widget renders (not site-wide) and its origin is in the
// CSP allowlist (lib/securityHeaders.mjs). No `integrity`: plugin-v1.js changes when
// Jupiter deploys (a pinned hash would break the swap), and it injects
// plugin-<version>-app.js itself without integrity, so a hash would not cover the
// code that actually runs.
const JUPITER_PLUGIN_SRC = "https://plugin.jup.ag/plugin-v1.js";
declare global {
  interface Window {
    Jupiter?: {
      init: (props: Record<string, unknown>) => void;
    };
  }
}

const urlOf = (input: unknown): string =>
  typeof input === "string" ? input : input instanceof Request ? input.url : String((input as { url?: string })?.url ?? "");

type Props = {
  /** Called once per successful swap with its signature. */
  onSwapped?: (txid: string) => void;
  /**
   * Minimum widget height (any CSS length, e.g. "var(--swap-min-h)"). The
   * widget lives in a shadow root capped at 360 x 550 with its own scrollbar;
   * containerStyles is applied inline to that box, so it is the only way to
   * let it fill our card. Height is auto above this minimum, so extra quote
   * rows (shown once a wallet is connected) grow the card instead of
   * scrolling inside it.
   */
  minHeight?: string;
};

export function JupiterSwap({ onSwapped, minHeight = "550px" }: Props = {}) {
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
  const onSwappedRef = useRef(onSwapped);
  onSwappedRef.current = onSwapped;

  useEffect(() => {
    let cancelled = false;
    let tries = 0;

    // Record only the txid (the always-correct value) plus the fee config constants.
    // Mints/amounts will be backfilled server-side from the on-chain tx via Helius.
    const seen = new Set<string>();
    const record = (txid: string) => {
      if (seen.has(txid)) return;
      seen.add(txid);
      onSwappedRef.current?.(txid);
      void recordSwap({
        txid,
        feeBps: FEE_ENABLED ? JUP_FEE_BPS : 0,
        referralAccount: FEE_ENABLED ? JUP_REFERRAL_ACCOUNT : null,
      });
    };

    // Capture the swap straight from Jupiter's Ultra network calls — the plugin's
    // onSuccess callback is unreliable in the Ultra flow, but /execute returns the
    // final signature. We observe it via a scoped fetch wrap.
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await origFetch(...args);
      try {
        const url = urlOf(args[0]);
        if (/jup\.ag/i.test(url)) {
          if (/\/execute(\b|\?|$)/.test(url)) {
            const d = await res.clone().json();
            const sig = (d?.signature ?? d?.txid) as string | undefined;
            if (sig && d?.status !== "Failed") record(sig);
          }
        }
      } catch {
        /* best-effort capture — ignore clone/parse errors */
      }
      return res;
    };

    function tryInit() {
      if (cancelled) return;
      if (typeof window === "undefined" || !window.Jupiter) {
        // ~15 s: the loader now starts after hydration instead of before it.
        if (tries++ > 150) {
          setStatus("unavailable");
          return;
        }
        window.setTimeout(tryInit, 100);
        return;
      }

      const formProps: Record<string, unknown> = {
        initialInputMint: SWAP_INPUT_MINT,
        initialOutputMint: SWAP_OUTPUT_MINT,
      };
      if (FEE_ENABLED) {
        formProps.referralAccount = JUP_REFERRAL_ACCOUNT;
        formProps.referralFee = JUP_FEE_BPS;
      }

      window.Jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "jupiter-plugin",
        branding: { logoUri: `${window.location.origin}/icon.png`, name: "$CATO Swap" },
        containerStyles: {
          maxWidth: "100%",
          height: "auto",
          minHeight,
          overflow: "visible",
          background: "transparent",
        },
        formProps,
        // Belt-and-suspenders: if onSuccess DOES fire, record from it too (idempotent by txid).
        onSuccess: (a: { txid?: string }) => {
          if (a?.txid) record(a.txid);
        },
      });
      setStatus("ready");
    }

    tryInit();
    return () => {
      cancelled = true;
      window.fetch = origFetch; // restore on unmount
    };
  }, []);

  return (
    <div>
      <Script src={JUPITER_PLUGIN_SRC} strategy="afterInteractive" onError={() => setStatus("unavailable")} />
      {/* The plugin renders its React tree into #jupiter-plugin; force that tree to
          fill the panel width so it doesn't sit narrow inside our wider card. */}
      <style jsx global>{`
        #jupiter-plugin,
        #jupiter-plugin > div,
        #jupiter-plugin > div > div {
          width: 100% !important;
          max-width: 100% !important;
        }
        /* Theme the widget with the site palette (values are "R, G, B"). */
        #jupiter-plugin {
          --jupiter-plugin-primary: 254, 169, 17;
          --jupiter-plugin-background: 25, 23, 21;
          --jupiter-plugin-primary-text: 245, 245, 245;
          --jupiter-plugin-warning: 251, 191, 36;
          --jupiter-plugin-interactive: 46, 39, 32;
          --jupiter-plugin-module: 18, 18, 18;
        }
      `}</style>
      <div id="jupiter-plugin" style={{ minHeight, width: "100%", margin: "0 auto" }} />
      {status === "loading" && (
        <p style={{ textAlign: "center", color: THEME.muted, marginTop: 16 }}>Loading the swap…</p>
      )}
      {status === "unavailable" && (
        <p style={{ textAlign: "center", color: THEME.accentStrong, marginTop: 16 }}>
          Couldn&apos;t load the Jupiter swap widget. Please refresh.
        </p>
      )}
    </div>
  );
}
