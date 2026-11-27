"use client";

import { useCallback, useEffect, useState } from "react";
import { THEME } from "../../lib/shareModel";
import { withTicker } from "../Ticker";

export type ToastKind = "success" | "error";

export interface StakingToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const AUTO_DISMISS_MS = 4_500;

interface StakingToastsProps {
  toasts: StakingToastItem[];
  onDismiss: (id: number) => void;
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: StakingToastItem;
  onDismiss: (id: number) => void;
}) {
  useEffect(() => {
    const timerId = window.setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timerId);
  }, [toast.id, onDismiss]);

  const isSuccess = toast.kind === "success";

  return (
    <div
      role="status"
      style={{
        pointerEvents: "auto",
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "14px 16px",
        borderRadius: 14,
        border: `1px solid ${isSuccess ? THEME.accent : THEME.error}`,
        background: isSuccess
          ? "linear-gradient(160deg, #1F1A12, #161310)"
          : "linear-gradient(160deg, #1F1214, #161010)",
        boxShadow: isSuccess
          ? "0 10px 28px rgba(254, 169, 17, 0.18)"
          : "0 10px 28px rgba(237, 41, 57, 0.22)",
        color: THEME.fg,
        fontFamily: "inherit",
        animation: "staking-toast-in 0.28s ease-out",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: 8,
          height: 8,
          marginTop: 6,
          borderRadius: "50%",
          background: isSuccess ? THEME.accent : THEME.error,
          boxShadow: isSuccess
            ? `0 0 10px ${THEME.accent}`
            : `0 0 10px ${THEME.error}`,
        }}
      />
      <p
        style={{
          margin: 0,
          flex: 1,
          fontSize: 14,
          lineHeight: 1.45,
          fontWeight: 600,
          color: isSuccess ? THEME.cream : "#FFD6DA",
        }}
      >
        {withTicker(toast.message)}
      </p>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        style={{
          flexShrink: 0,
          border: "none",
          background: "transparent",
          color: THEME.muted,
          cursor: "pointer",
          fontSize: 18,
          lineHeight: 1,
          padding: 0,
          fontFamily: "inherit",
        }}
      >
        ×
      </button>
    </div>
  );
}

export function StakingToasts({ toasts, onDismiss }: StakingToastsProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        left: 20,
        bottom: 20,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column-reverse",
        gap: 10,
        maxWidth: "min(360px, calc(100vw - 40px))",
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
      <style>{`
        @keyframes staking-toast-in {
          from {
            opacity: 0;
            transform: translateY(12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}

/** Local toast queue for staking success/error notifications. */
export function useStakingToasts() {
  const [toasts, setToasts] = useState<StakingToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, kind, message }].slice(-4));
  }, []);

  return { toasts, pushToast, dismissToast };
}

export function toastErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("user rejected") || msg.includes("rejected the request")) {
      return "Transaction cancelled in wallet.";
    }
    if (msg.includes("insufficient")) {
      return "Not enough balance for this transaction.";
    }
    // Prefer short intentional Error messages (e.g. early-guard throws).
    if (err.message.length > 0 && err.message.length <= 120 && !err.message.includes("\n")) {
      return err.message;
    }
  }
  return fallback;
}
