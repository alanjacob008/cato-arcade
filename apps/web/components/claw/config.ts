/** Shared dimensions for rendering, collisions, movement, and saved-pose validation. */
export const MACHINE = Object.freeze({ width: 3.0, depth: 2.8, height: 4.2, boxCount: 64, boxSize: .48, floorY: .02, clawMargin: .15 });

/** Keep high-value prizes off the initial exposed surface, at any covered depth. */
export const PILE_LAYOUT = Object.freeze({ coveredPrizeMinCents: 1000 });

/** Minimum expected gross margin supporting VRF and API operating costs. */
export const OPERATING_MARGIN = .05;
export const ENTRY_USD = Object.freeze({ USDC: Object.freeze([2, 4, 6]) });
export const PRIZE_INVENTORY = Object.freeze([
  { count: 12, cents: 100, peak: .9, color: "#f5f1fa" },
  { count: 12, cents: 150, peak: .8, color: "#f5f1fa" },
  { count: 24, cents: 200, peak: .8, color: "#f5f1fa" },
  { count: 6, cents: 300, peak: .7, color: "#ee9951" },
  { count: 6, cents: 500, peak: .55, color: "#ee9951" },
  { count: 2, cents: 1000, peak: .38, color: "#7950b4" },
  { count: 2, cents: 2000, peak: .22, color: "#7950b4" },
].map((entry) => Object.freeze(entry)));
export const MIN_PRIZE_CENTS = Math.min(...PRIZE_INVENTORY.map((entry) => entry.cents));
export const MAX_PRIZE_CENTS = Math.max(...PRIZE_INVENTORY.map((entry) => entry.cents));
export const ARENA = Object.freeze({ minX: -MACHINE.width / 2 + MACHINE.clawMargin, maxX: MACHINE.width / 2 - MACHINE.clawMargin,
  minZ: -MACHINE.depth / 2 + MACHINE.clawMargin, maxZ: MACHINE.depth / 2 - MACHINE.clawMargin, height: MACHINE.height });

/** Start above the mound, clear of the delivery pocket in the narrower cabinet. */
export const INITIAL_AIM: Readonly<{ x: number; z: number }> = Object.freeze({ x: 0, z: 0 });

/** Front-left delivery bay: excluded from loading and subsequent pile settling. */
export const POCKET = Object.freeze({ minX: -MACHINE.width / 2, maxX: -MACHINE.width / 2 + 1.05,
  minZ: MACHINE.depth / 2 - 1.05, maxZ: MACHINE.depth / 2, wallThickness: .06, wallHeight: 1.8, floorY: -.62 });
