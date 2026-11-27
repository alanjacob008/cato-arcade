import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import styles from "./player.module.css";

/** A stationary 3D coin with a fixed viewing tilt and layered edge depth. */
export default function UsdcAmount({ value }: { value: ReactNode }) {
  return <span className={styles.usdcAmount}>
    <span className={styles.usdcCoinScene} aria-hidden="true">
      <span className={styles.usdcCoinTilt}><span className={styles.usdcCoinBody}>
        {Array.from({ length: 7 }, (_, layer) => <span key={layer} className={styles.usdcCoinEdge}
          style={{ "--coin-depth": (layer - 3) * .035 } as CSSProperties} />)}
        <span className={styles.usdcCoinBack} />
        <span className={styles.usdcCoinFace}><Image src="/claw/usdc-icon.png" width={24} height={24} alt="" draggable={false} /></span>
      </span></span>
    </span>
    <span>{value}</span><span className={styles.screenReaderOnly}> USDC</span>
  </span>;
}
