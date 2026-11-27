import type { ShareData } from "@cato/shared";
import { fetchShare } from "../../../lib/api";
import { renderCollectibleImage } from "../../../lib/cardImage";

export const runtime = "nodejs";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Server-generated collectible "cat card" for social embeds + downloads.
export default async function OgImage({ params }: { params: { wallet: string } }) {
  let data: ShareData | null = null;
  try {
    data = await fetchShare(params.wallet);
  } catch {
    data = null;
  }
  return renderCollectibleImage(data);
}
