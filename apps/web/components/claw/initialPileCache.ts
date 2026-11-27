import { DAILY_LAYOUT_VERSION, restoreDailyPile, type DailyArrangement, type DemoStorage } from "./daily";
import { assignInitialPrizes, pileBlueprint } from "./pile";
import type { PrizeBox } from "./rewards";

const cacheKey = (arrangement: DailyArrangement) => `cato-claw-initial-v1:${DAILY_LAYOUT_VERSION}:${arrangement.playerId}`;

/** Optional demo pose cache. Payouts and token balances are never cached here. */
export function readInitialPileCache(storage: DemoStorage | null, arrangement: DailyArrangement): PrizeBox[] | null {
  try {
    const templates = pileBlueprint(arrangement.seed);
    const poses = restoreDailyPile(storage?.getItem(cacheKey(arrangement)) ?? null, arrangement, templates);
    if (!poses || poses.length !== templates.length) return null;
    const byId = new Map(poses.map(box => [box.id, box]));
    return assignInitialPrizes(templates.map(box => byId.get(box.id)!), arrangement.seed);
  } catch { return null; }
}

export function saveInitialPileCache(storage: DemoStorage | null, arrangement: DailyArrangement, boxes: readonly PrizeBox[]): void {
  try {
    storage?.setItem(cacheKey(arrangement), JSON.stringify({ arrangementId: arrangement.id,
      boxes: boxes.map(({ id, center, rotation, grabPoint }) => ({ id, center, rotation, grabPoint })) }));
  } catch { /* Quota or privacy restrictions must not prevent the uncached game loading. */ }
}
