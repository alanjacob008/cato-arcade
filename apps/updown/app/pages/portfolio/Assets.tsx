import Balances from "@/game/Balances";
import { generatePageTitle } from "@/utils/utils";
import { getPageMeta } from "@/utils/seo";
import { renderSEOTags } from "@/utils/seo-tags";

export default function PortfolioAssets() {
  const pageMeta = getPageMeta();
  const pageTitle = generatePageTitle("Balances");

  return (
    <>
      {renderSEOTags(pageMeta, pageTitle)}
      <Balances />
    </>
  );
}
