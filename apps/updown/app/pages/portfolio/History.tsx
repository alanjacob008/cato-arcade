import DepositHistory from "@/game/DepositHistory";
import { getPageMeta } from "@/utils/seo";
import { generatePageTitle } from "@/utils/utils";
import { renderSEOTags } from "@/utils/seo-tags";

// Players only ever see deposits and withdrawals here, in one table. The SDK's
// history pages also expose funding, distribution, transfer, convert and vault
// history, which is perps machinery and not part of the game.
export default function PortfolioHistory() {
  const pageMeta = getPageMeta();
  const pageTitle = generatePageTitle("History");

  return (
    <>
      {renderSEOTags(pageMeta, pageTitle)}
      <DepositHistory />
    </>
  );
}
