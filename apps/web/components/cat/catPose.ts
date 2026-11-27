/**
 * Cato's poses on the staking card. Every image is a 1080 x 1320 WebP with the
 * paws resting on the same line (y = 952), so swapping poses never shifts the
 * cat; taller poses (sitting, stretching) simply rise higher above the card.
 * Source art and cleanup notes live in cato-image-prompts/ at the repo root.
 */
export type CatPose =
  | "asleep"
  | "waking"
  | "alert"
  | "guarding"
  | "waiting"
  | "celebrate"
  | "gift"
  | "wave"
  | "confused";

export const CAT_POSES: CatPose[] = [
  "asleep",
  "waking",
  "alert",
  "guarding",
  "waiting",
  "celebrate",
  "gift",
  "wave",
  "confused",
];

export const catPoseSrc = (pose: CatPose) => `/cato/${pose}.webp`;

/** Canvas geometry, used by the stylesheet to seat the paws on the card edge. */
export const CAT_CANVAS = { width: 1080, height: 1320, pawLine: 952 } as const;

/** Short-lived reactions that override the state-based pose. */
export type CatFlash = "waking" | "celebrate" | "confused";

export const FLASH_MS: Record<CatFlash, number> = {
  waking: 2600,
  celebrate: 2800,
  confused: 2800,
};

type PoseInput = {
  connected: boolean;
  flash: CatFlash | null;
  pending: boolean;
  chatOpen: boolean;
  tab: "stake" | "withdraw" | "rewards";
  amountEntered: boolean;
  overLimit: boolean;
  claimable: number;
};

/** Picks the pose for the current card state, most specific first. */
export function chooseCatPose(s: PoseInput): CatPose {
  if (!s.connected) return "asleep";
  if (s.flash) return s.flash;
  if (s.pending) return "waiting";
  if (s.chatOpen) return "alert";
  if (s.overLimit) return "confused";
  if (s.tab === "rewards") return s.claimable > 0 ? "gift" : "alert";
  if (s.tab === "withdraw") return "wave";
  return s.amountEntered ? "guarding" : "alert";
}
