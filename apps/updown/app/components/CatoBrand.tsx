import { withBasePath } from "@/utils/base-path";

/** The main Cato site's header wordmark (apps/web/components/Header.tsx). */
export const CATO_SITE_WORDMARK = "First CAT on Solana";

/** Header wordmark, styled to match the main Cato site (styles/header.css). */
export function CatoSiteBrand() {
  return <span className="cato-site-brand">{CATO_SITE_WORDMARK}</span>;
}

/** Product lockup used by SDK surfaces (appIcons) and the error page. */
export function CatoBrand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`cato-brand${compact ? " cato-brand--compact" : ""}`}>
      <img src={withBasePath("/cato-icon.png")} alt="" width="48" height="48" />
      <span className="cato-brand-wordmark">
        Up <span>Down</span>
      </span>
    </span>
  );
}
