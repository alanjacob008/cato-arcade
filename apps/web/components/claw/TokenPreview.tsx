import Image from "next/image";
import type { TokenTier } from "./tokens";
import styles from "./player.module.css";

/**
 * The token pictures are static renders of the real 3D tokens (tokenThumbnails.ts), so the tray shows them from its
 * first frame and the arcade never opens a second WebGL context while it loads or flies in.
 */
const TOKEN_PICTURES = ["/claw/tokens/silver.webp", "/claw/tokens/gold.webp", "/claw/tokens/diamond.webp"] as const;

export default function TokenPreview({ tier }: { tier: TokenTier }) {
  return <span className={styles.tokenPreview} data-tier={tier} aria-hidden="true">
    <Image src={TOKEN_PICTURES[tier]} width={160} height={144} alt="" loading="eager" unoptimized />
  </span>;
}
