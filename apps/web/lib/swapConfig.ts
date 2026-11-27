/** Jupiter swap widget configuration (read by JupiterSwap.tsx). */

/** Native SOL mint (wrapped SOL pseudo-mint Jupiter uses for the SOL side). */
export const SOL_MINT = "So11111111111111111111111111111111111111112";

/** CATO SPL mint (mirrors CATO_MINT in @cato/shared/constants). */
export const CATO_MINT = "5p2zjqCd1WJzAVgcEnjhb9zWDU7b9XVhFhx4usiyN7jB";

/** Default swap: pay SOL, receive CATO. */
export const SWAP_INPUT_MINT = SOL_MINT;
export const SWAP_OUTPUT_MINT = CATO_MINT;

/**
 * Integrator fee. Jupiter only collects a fee when a referral account is set,
 * and the fee must be 50–255 bps (0.5%–2.55%). We default to the 50 bps floor
 * ("a very small fee"). Set NEXT_PUBLIC_JUP_REFERRAL_ACCOUNT to a referral
 * account created at https://referral.jup.ag to actually capture fees; until
 * then the widget works fee-free.
 */
export const JUP_REFERRAL_ACCOUNT = process.env.NEXT_PUBLIC_JUP_REFERRAL_ACCOUNT ?? "";

const rawBps = Number(process.env.NEXT_PUBLIC_JUP_FEE_BPS ?? "50");
/** Clamp to Jupiter's documented 50–255 bps range. */
export const JUP_FEE_BPS = Number.isFinite(rawBps) ? Math.min(255, Math.max(50, Math.round(rawBps))) : 50;

/** Whether fee capture is configured (referral account present). */
export const FEE_ENABLED = JUP_REFERRAL_ACCOUNT.length > 0;
