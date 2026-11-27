"use client";

import { useEffect, useRef, useState } from "react";
import { shortWallet } from "../../lib/shareModel";
import { useShrinkOnScroll } from "../../hooks/useShrinkOnScroll";
import { Ticker } from "../Ticker";
import { catPoseSrc } from "../cat/catPose";
import w from "./wrapped.module.css";

/**
 * Story hero (the cat, the title and the wallet) that scrolls away, plus a
 * compact bar that slides in under the site header once you're past it. The
 * header height is measured rather than hardcoded.
 */
export function StickyCatBanner({ wallet }: { wallet: string }) {
  const heroRef = useRef<HTMLDivElement>(null);
  const shrunk = useShrinkOnScroll(heroRef);
  const [headerH, setHeaderH] = useState(67);

  useEffect(() => {
    const h = document.querySelector("header")?.offsetHeight;
    if (h) setHeaderH(h);
  }, []);

  return (
    <>
      <div ref={heroRef} className={w.hero}>
        <img src={catPoseSrc("waking")} alt="" className={w.heroCat} width={1080} height={1320} />
        <h1 className={w.heroTitle}>
          <Ticker /> Wrapped
        </h1>
        <span className={w.walletChip}>{shortWallet(wallet)}</span>
      </div>

      <div className={w.compact} data-show={shrunk} style={{ top: headerH }}>
        <img src="/icon.png" alt="" width={30} height={30} />
        <strong>
          <Ticker /> Wrapped
        </strong>
        <span className={w.compactWallet}>{shortWallet(wallet)}</span>
      </div>
    </>
  );
}
