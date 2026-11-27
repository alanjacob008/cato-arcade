"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { HiOutlineXMark } from "react-icons/hi2";
import TokenPreview from "./TokenPreview";
import UsdcAmount from "./UsdcAmount";
import { TOKEN_TYPES, TOKEN_BATCHES, MAX_TOKEN_QUANTITY, isTokenQuantity, tokenTier, type TokenTier } from "./tokens";
import styles from "./player.module.css";
import shell from "./arcadeShell.module.css";

export default function TokenShop({ initialTier, onClose, onBuy, testMode = false, fundedDevnet = false }: { initialTier: number; onClose: () => void; onBuy: (tier: TokenTier, quantity: number) => void | Promise<void>; testMode?: boolean; fundedDevnet?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitted = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState(tokenTier(initialTier)), [batch, setBatch] = useState<number>(10);
  const [custom, setCustom] = useState(false), [customValue, setCustomValue] = useState("");
  const quantityLimit = testMode ? 100 : fundedDevnet ? 1000 : MAX_TOKEN_QUANTITY;
  const entered = Number(customValue);
  const quantity = custom ? customValue.trim() && isTokenQuantity(entered) && entered <= quantityLimit ? entered : null : batch;
  const quantityError = custom && customValue !== "" && quantity === null;
  useEffect(() => {
    const modal = dialog.current, previous = document.activeElement;
    modal?.showModal();
    return () => { modal?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const type = TOKEN_TYPES[tier];
  return <dialog ref={dialog} className={`${styles.tokenShop} ${shell.dialog}`} aria-labelledby="token-shop-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form noValidate onSubmit={async event => {
      event.preventDefault(); if (submitted.current || quantity === null) return;
      submitted.current = true; setSubmitting(true);
      try { await onBuy(tier, quantity); onClose(); }
      catch (value) { submitted.current = false; setSubmitting(false); setError(value instanceof Error ? value.message.replaceAll("_", " ") : "Unable to add tokens."); }
    }}>
      <div className={styles.shopHeading}><h2 id="token-shop-title">{testMode ? "Get free test tokens" : fundedDevnet ? "Buy devnet tokens" : "Buy arcade tokens"}</h2><button type="button" className={styles.shopClose} aria-label="Close token shop" onClick={onClose}><HiOutlineXMark aria-hidden="true" /></button></div>
      <div className={styles.shopTypes}>
        {TOKEN_TYPES.map((type, index) => <button type="button" key={type.name} data-arcade-sound={type.name.toLowerCase()} aria-pressed={tier === index} onClick={() => setTier(tokenTier(index))} style={{ "--token-accent": type.color } as CSSProperties}>
          <TokenPreview tier={tokenTier(index)} /><strong>{type.name}</strong><UsdcAmount value={type.priceCents / 100} />
        </button>)}
      </div>
      <fieldset className={styles.batchPicker}><legend>How many tokens?</legend>{TOKEN_BATCHES.map(option => <button type="button" key={option} aria-pressed={!custom && batch === option} onClick={() => { setBatch(option); setCustom(false); setError(null); }}>{option}</button>)}
        <input type="number" inputMode="numeric" min={1} max={quantityLimit} step={1} placeholder="Custom" aria-label="Custom token quantity" aria-invalid={quantityError} aria-describedby={quantityError ? "token-quantity-error" : undefined} data-selected={custom} value={customValue} onFocus={() => { setCustom(true); setError(null); }} onChange={event => { setCustomValue(event.target.value); setCustom(true); setError(null); }} />
      </fieldset>
      {quantityError && <p id="token-quantity-error" className={styles.quantityError} role="alert">Enter a whole number from 1 to {quantityLimit.toLocaleString("en-US")}.</p>}
      <div className={styles.shopTotal}><span>{quantity === null ? "Choose a quantity" : `${quantity} ${type.name.toLowerCase()} ${quantity === 1 ? "token" : "tokens"}`}</span><strong><UsdcAmount value={quantity === null ? "—" : quantity * type.priceCents / 100} /></strong></div>
      <p className={styles.networkFeeNote}>{testMode ? "Free test tokens · No wallet payment · 100 extra tokens per day" : fundedDevnet ? "Devnet USDC only · Network fees covered by CATO" : "No added network fee · Covered by CATO"}</p>
      <button type="submit" className={`${styles.drop} ${shell.play}`} disabled={quantity === null || submitting}>{submitting ? fundedDevnet ? "CONFIRMING ON SOLANA…" : "ADDING…" : quantity === null ? "ADD TOKENS" : `${fundedDevnet?"BUY":"ADD"} ${quantity} ${type.name.toUpperCase()} ${testMode ? "TEST " : ""}${quantity === 1 ? "TOKEN" : "TOKENS"}`}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  </dialog>;
}
