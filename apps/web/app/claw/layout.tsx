import type { ReactNode } from "react";
import localFont from "next/font/local";
import styles from "./layout.module.css";

const popup = localFont({ src: "../../public/claw/fonts/tt-prosto-sans-bold.otf", weight: "700", variable: "--font-cato-popup", display: "swap" });

export default function ClawLayout({ children }: { children: ReactNode }) {
  return <div className={styles.shell + " " + popup.variable}>{children}</div>;
}
