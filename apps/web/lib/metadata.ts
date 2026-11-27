import type { ShareData } from "@cato/shared";
import { ogSinceLabel, topPercentLabel, formatCato } from "./shareModel";

export interface ShareMetadata {
  title: string;
  description: string;
  openGraph: { title: string; description: string; images: string[] };
  twitter: { card: "summary_large_image"; title: string; description: string; images: string[] };
}

/**
 * Build OG/Twitter metadata for a wallet's share page so X unfurls the
 * server-generated image (design D9). The OG image lives at the route's
 * `opengraph-image` segment.
 */
export function buildShareMetadata(data: ShareData, baseUrl: string): ShareMetadata {
  const title = "$CATO Wrapped";
  const parts = [formatCato(data.balance), ogSinceLabel(data.ogSince), topPercentLabel(data.pctBalance)]
    .filter((s): s is string => Boolean(s));
  const description = parts.join(" · ");
  const image = `${baseUrl.replace(/\/$/, "")}/w/${data.wallet}/opengraph-image`;

  return {
    title,
    description,
    openGraph: { title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}
