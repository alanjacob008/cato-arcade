import { Fragment, type ReactNode } from "react";
import s from "./ticker.module.css";

export const TICKER = "$CATO";

/**
 * The token ticker, set in the brand orange. On light surfaces (the cream
 * speech bubble, cream buttons) the parent sets --ticker-color to keep it
 * readable.
 */
export function Ticker() {
  return <span className={s.ticker}>{TICKER}</span>;
}

/** Renders a plain string, turning every "$CATO" in it into <Ticker />. */
export function withTicker(text: string | null | undefined): ReactNode {
  if (!text) return text;
  const parts = text.split(TICKER);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && <Ticker />}
    </Fragment>
  ));
}
