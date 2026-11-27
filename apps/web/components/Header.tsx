"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CLAW_URL, DOCS_URL, GAMES_LINKS, SOCIAL_LINKS, STAKING_URL, gamesActive, stakingActive } from "../lib/links";
import { EnterArcadeLink } from "./arcadeEntry/EnterArcadeLink";

/** Where the wide nav takes over from the phone menu (globals.css hides .site-nav__wide below it). */
const WIDE_QUERY = "(min-width: 900px)";
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Current = (active: boolean) => "page" | undefined;

/**
 * Site header: dark glass, amber for the current page. "Arcade" is first and plays the entry
 * curtain; on phones the rest of the links open in a full-screen menu. Hidden on /claw routes,
 * where the arcade has its own header. Styles: app/globals.css (.site-header).
 */
export function Header() {
  const [openSocials, setOpenSocials] = useState(false);
  const [openGames, setOpenGames] = useState(false);
  const [openMenu, setOpenMenu] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname() ?? "/";

  // Close every menu when the route changes.
  useEffect(() => { setOpenMenu(false); setOpenGames(false); setOpenSocials(false); }, [pathname]);

  // The dropdowns close on Escape (the phone menu handles its own keys).
  useEffect(() => {
    if (!openGames && !openSocials) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpenGames(false); setOpenSocials(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openGames, openSocials]);

  // The phone menu has no toggle on a wide screen: close it when the window grows past the phone layout.
  useEffect(() => {
    if (!openMenu) return;
    const wide = window.matchMedia(WIDE_QUERY);
    const onChange = () => { if (wide.matches) setOpenMenu(false); };
    onChange();
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [openMenu]);

  const closeMenu = useCallback(() => setOpenMenu(false), []);

  if (pathname === "/claw" || pathname.startsWith("/claw/")) return null;

  const isStaking = stakingActive(pathname);
  const swapActive = pathname.startsWith("/swap");
  const wrappedActive = pathname.startsWith("/wrapped") || pathname.startsWith("/w/");
  // Games: Claw (open, devnet) and Up Down (VIP sign-in at "/play", game under "/updown").
  const gameRouteActive = gamesActive(pathname);
  const current: Current = (active) => (active ? "page" : undefined);

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link href="/" className="site-brand">
          First CAT on Solana
        </Link>

        <nav className="site-nav" aria-label="Main">
          <EnterArcadeLink href={CLAW_URL} className="site-nav__link site-nav__arcade">
            <span className="site-nav__dot" aria-hidden="true" />
            Arcade
          </EnterArcadeLink>
          <div className="site-nav__wide">
            <Link href={STAKING_URL} className="site-nav__link" aria-current={current(isStaking)}>Staking</Link>
            <Link href="/swap" className="site-nav__link" aria-current={current(swapActive)}>Swap</Link>
            <Link href="/wrapped" className="site-nav__link" aria-current={current(wrappedActive)}>Wrapped</Link>

            <div className="site-nav__menu">
              <button
                type="button"
                className="site-nav__link site-nav__button"
                data-current={gameRouteActive ? "true" : undefined}
                onClick={() => { setOpenGames((v) => !v); setOpenSocials(false); }}
                aria-haspopup="menu"
                aria-expanded={openGames}
              >
                Games <span className="site-nav__chev" aria-hidden="true">▾</span>
              </button>
              {openGames && (
                <>
                  <div className="site-nav__away" onClick={() => setOpenGames(false)} />
                  <div role="menu" className="site-nav__panel">
                    {GAMES_LINKS.map((g) => (
                      <Link key={g.label} href={g.href} role="menuitem" className="site-nav__item" onClick={() => setOpenGames(false)}>
                        {g.label}
                        <span className="site-nav__tag">{g.tag}</span>
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </div>

            <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="site-nav__link">
              Docs <span aria-hidden="true">↗</span>
            </a>

            <div className="site-nav__menu">
              <button
                type="button"
                className="site-nav__link site-nav__button site-nav__outline"
                onClick={() => { setOpenSocials((v) => !v); setOpenGames(false); }}
                aria-haspopup="menu"
                aria-expanded={openSocials}
              >
                Socials <span className="site-nav__chev" aria-hidden="true">▾</span>
              </button>
              {openSocials && (
                <>
                  <div className="site-nav__away" onClick={() => setOpenSocials(false)} />
                  <div role="menu" className="site-nav__panel">
                    {SOCIAL_LINKS.map((s) => (
                      <a key={s.href} href={s.href} target="_blank" rel="noopener noreferrer" role="menuitem" className="site-nav__item" onClick={() => setOpenSocials(false)}>
                        <span className="site-nav__icon" aria-hidden="true">{s.icon}</span>
                        {s.label} <span className="site-nav__ext" aria-hidden="true">↗</span>
                      </a>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <button
            ref={toggleRef}
            type="button"
            className="site-nav__link site-nav__button site-nav__outline site-nav__toggle"
            aria-expanded={openMenu}
            aria-controls="site-menu"
            aria-haspopup="dialog"
            onClick={() => setOpenMenu(true)}
          >
            Menu
          </button>
        </nav>
      </div>

      {openMenu && (
        <PhoneMenu
          onClose={closeMenu}
          returnFocus={toggleRef}
          current={current}
          isStaking={isStaking}
          swapActive={swapActive}
          wrappedActive={wrappedActive}
        />
      )}
    </header>
  );
}

/**
 * The phone menu: a full-screen dialog on document.body (outside the header, whose backdrop blur
 * would otherwise be the containing block of anything fixed inside it). Its top bar repeats the
 * header, with Close where Menu was. Focus moves in on open, Tab stays inside, the page behind is
 * inert, Escape or any link closes it, and focus returns to the Menu button (or, when the window has
 * grown past the phone layout and Menu is hidden, to the wide nav's Arcade link).
 */
function PhoneMenu({ onClose, returnFocus, current, isStaking, swapActive, wrappedActive }: {
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
  current: Current;
  isStaking: boolean;
  swapActive: boolean;
  wrappedActive: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const toggle = returnFocus.current;
    // Everything behind the menu is inert and the page does not scroll under it.
    const madeInert: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (!(el instanceof HTMLElement) || el === dialog || el.inert) continue;
      el.inert = true;
      madeInert.push(el);
    }
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    dialog.querySelector<HTMLElement>(".site-sheet__nav a")?.focus({ preventScroll: true });

    // Escape closes; Tab and Shift+Tab go round the menu's own controls.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab") return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (e.shiftKey && (!inside || active === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || active === last)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const el of madeInert) el.inert = false;
      root.style.overflow = overflow;
      // Back to Menu, unless the menu closed because the window grew past the phone layout: then Menu is hidden,
      // and focus goes to the wide nav's Arcade link (or the brand) instead of falling to <body>.
      const shown = (el: HTMLElement | null | undefined): el is HTMLElement => !!el?.isConnected && el.getClientRects().length > 0;
      const header = toggle?.closest(".site-header") ?? document.querySelector(".site-header");
      const target = [toggle, header?.querySelector<HTMLElement>(".site-nav__arcade"), header?.querySelector<HTMLElement>(".site-brand")].find(shown);
      target?.focus({ preventScroll: true });
    };
  }, [onClose, returnFocus]);

  return createPortal(
    <div id="site-menu" ref={dialogRef} className="site-sheet" role="dialog" aria-modal="true" aria-label="Menu">
      <div className="site-sheet__bar">
        <div className="site-header__inner">
          <Link href="/" className="site-brand" onClick={onClose}>First CAT on Solana</Link>
          <button type="button" className="site-nav__link site-nav__button site-nav__outline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <div className="site-sheet__body">
        <nav className="site-sheet__nav" aria-label="Main, phone">
          <EnterArcadeLink href={CLAW_URL} className="site-sheet__link" onEnter={onClose}>
            <span className="site-nav__dot" aria-hidden="true" /> Arcade
          </EnterArcadeLink>
          <Link href={STAKING_URL} className="site-sheet__link" aria-current={current(isStaking)} onClick={onClose}>Staking</Link>
          <Link href="/swap" className="site-sheet__link" aria-current={current(swapActive)} onClick={onClose}>Swap</Link>
          <Link href="/wrapped" className="site-sheet__link" aria-current={current(wrappedActive)} onClick={onClose}>Wrapped</Link>
          {GAMES_LINKS.map((g) => (
            <Link key={g.label} href={g.href} className="site-sheet__link site-sheet__link--small" onClick={onClose}>
              {g.label} <span className="site-nav__tag">{g.tag}</span>
            </Link>
          ))}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="site-sheet__link site-sheet__link--small" onClick={onClose}>
            Docs <span aria-hidden="true">↗</span>
          </a>
        </nav>
        <div className="site-sheet__socials">
          {SOCIAL_LINKS.map((s) => (
            <a key={s.href} href={s.href} target="_blank" rel="noopener noreferrer" className="site-sheet__social" onClick={onClose}>
              {s.label}
            </a>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
