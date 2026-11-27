"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { isPlainLeftClick, requestArcadeEntry } from "./entry";

type AnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">;

export interface EnterArcadeLinkProps extends AnchorProps {
  href: string;
  children: ReactNode;
  /** The viewport point the iris closes on; defaults to the centre of the screen. */
  getFocus?: () => { x: number; y: number } | null;
  /** Runs as the entry starts (the hero pushes its picture in toward the machine). */
  onEnter?: () => void;
}

/** What the curtain's stand-in loading screen draws: fetched with the route, so the marquee is ready when the iris closes. */
const STAND_IN_IMAGES = ["/claw/cato-mascot-transparent.png", "/claw/brand/magicblock-logo.svg"];
const STAND_IN_FONT = '400 40px "CATO Onboarding Pixel"';

/**
 * A real link into the arcade. A plain left click plays the entry curtain and then navigates;
 * a modified click (new tab, new window) behaves as a normal link. The route is prefetched on
 * hover, focus and touch so the arcade's code is ready when the curtain closes.
 */
export function EnterArcadeLink({ href, children, getFocus, onEnter, onPointerEnter, onFocus, onTouchStart, ...rest }: EnterArcadeLinkProps) {
  const router = useRouter();
  const prefetched = useRef(false);
  const prefetch = useCallback(() => {
    if (prefetched.current) return;
    prefetched.current = true;
    try { router.prefetch(href); } catch { /* prefetch is a hint */ }
    try { document.fonts?.load(STAND_IN_FONT).catch(() => { /* the marquee falls back to the system face */ }); } catch { /* no font loading API */ }
    for (const src of STAND_IN_IMAGES) { const img = new Image(); img.src = src; }
  }, [href, router]);

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainLeftClick(e)) return;
    e.preventDefault();
    prefetch();
    const focus = getFocus?.() ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    onEnter?.();
    requestArcadeEntry({ href, x: focus.x, y: focus.y });
  };

  return (
    <Link
      href={href}
      {...rest}
      onClick={onClick}
      onPointerEnter={(e) => { prefetch(); onPointerEnter?.(e); }}
      onFocus={(e) => { prefetch(); onFocus?.(e); }}
      onTouchStart={(e) => { prefetch(); onTouchStart?.(e); }}
    >
      {children}
    </Link>
  );
}
