"use client";

import type { ReactNode } from "react";
import { withTicker } from "../Ticker";
import { catPoseSrc, type CatPose } from "./catPose";
import s from "./catPerch.module.css";

type Props = {
  pose: CatPose;
  /** What Cato says. "$CATO" in it is rendered as the orange ticker. */
  line: string;
  /** Optional small action under the line (a link or button). */
  action?: ReactNode;
  /** Makes the cat itself clickable. */
  onCatClick?: () => void;
  catLabel?: string;
  catExpanded?: boolean;
};

/**
 * Cato resting on the top edge of a card, with a speech bubble to the right.
 * Place it inside a `position: relative` wrapper whose top edge is the card's
 * top edge. Sizing comes from two CSS variables set by the page:
 *   --cat    width of the cat image
 *   --perch  room reserved above the card (the bubble sits at its top)
 */
export function CatPerch({ pose, line, action, onCatClick, catLabel, catExpanded }: Props) {
  const img = (
    <img
      key={pose}
      src={catPoseSrc(pose)}
      alt=""
      width={1080}
      height={1320}
      className={`${s.cat} ${pose === "asleep" ? s.asleep : s.awake}`}
    />
  );

  return (
    <>
      {onCatClick ? (
        <button
          type="button"
          className={`${s.perch} ${s.clickable}`}
          onClick={onCatClick}
          aria-label={catLabel}
          aria-expanded={catExpanded}
        >
          {img}
        </button>
      ) : (
        <div className={s.perch} aria-hidden>
          {img}
        </div>
      )}
      <div className={s.bubble}>
        <span key={line} className={s.bubbleText} aria-live="polite">
          {withTicker(line)}
        </span>
        {action}
      </div>
    </>
  );
}

/** Class for a text-style action inside the bubble (link or button). */
export const bubbleActionClass = s.action;
