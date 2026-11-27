import { ENTRY_USD, PRIZE_INVENTORY } from "./config";
import { EMPTY_TOTALS, recordCompletedPlay, type PlayerTotals } from "./playerStats";

export type TokenTier = 0 | 1 | 2;
export const TOKEN_TYPES = Object.freeze([
  Object.freeze({ name: "Silver", color: "#c5d3e8", priceCents: ENTRY_USD.USDC[0] * 100 }),
  Object.freeze({ name: "Gold", color: "#f5c45e", priceCents: ENTRY_USD.USDC[1] * 100 }),
  Object.freeze({ name: "Diamond", color: "#BFF4FF", priceCents: ENTRY_USD.USDC[2] * 100 }),
]);
export const TOKEN_BATCHES = [1, 5, 10, 20] as const;
export const MAX_TOKEN_QUANTITY = 10_000;
export const isTokenQuantity = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_TOKEN_QUANTITY;
type Purchase = Readonly<{ tier: TokenTier; quantity: number }>;
type UsedToken = Readonly<{ tier: TokenTier; prizeCents: number }>;
export type WithdrawalScope = "session" | "all";
type Withdrawal = Readonly<{ cents: number; sessionCents: number; sessionId: string; scope: WithdrawalScope }>;
export type TokenWallet = Readonly<{
  version: 1; balances: readonly [number, number, number];
  purchases: Readonly<Record<string, Purchase>>; used: Readonly<Record<string, UsedToken>>;
  withdrawals: Readonly<Record<string, Withdrawal>>;
  pending: Readonly<{ id: string; tier: TokenTier }> | null;
  baseTotals: PlayerTotals; totals: PlayerTotals;
}>;
const CURRENT_PRIZES = new Set([0, ...PRIZE_INVENTORY.map(prize => prize.cents)]);
// Preserve receipts from the previous inventory without issuing its retired prizes.
const HISTORICAL_PRIZES = new Set([...CURRENT_PRIZES, 50, 2500]);
const MAX_RECORDS = 10_000, MAX_BALANCE = MAX_TOKEN_QUANTITY;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(id);
export function tokenTier(value: number): TokenTier {
  if (!Number.isInteger(value) || value < 0 || value > 2) throw new Error("Invalid token type");
  return value as TokenTier;
}
export function createTokenWallet(baseTotals: PlayerTotals = EMPTY_TOTALS): TokenWallet {
  recordCompletedPlay(baseTotals, 0, 0);
  return { version: 1, balances: [0, 0, 0], purchases: {}, used: {}, withdrawals: {}, pending: null, baseTotals, totals: baseTotals };
}
export const tokenWalletKey = (playerId: string) => `cato-claw-demo-tokens-v1:${playerId}`;

// Demo business logic. Browser storage cannot authorize real USDC-funded credits.
export function buyDemoTokens(wallet: TokenWallet, id: string, tierValue: number, quantity: number): TokenWallet {
  const tier = tokenTier(tierValue);
  if (!validId(id) || !isTokenQuantity(quantity)) throw new Error("Invalid token purchase");
  if (Object.hasOwn(wallet.purchases, id)) {
    const prior = wallet.purchases[id];
    if (prior.tier !== tier || prior.quantity !== quantity) throw new Error("Purchase ID reused with different inputs");
    return wallet;
  }
  if (Object.keys(wallet.purchases).length >= MAX_RECORDS || wallet.balances[tier] + quantity > MAX_BALANCE) throw new Error("Demo token limit reached");
  const balances: [number, number, number] = [...wallet.balances]; balances[tier] += quantity;
  // Buying unspent credits does not count as a played entry or reduce winnings.
  return { ...wallet, balances, purchases: { ...wallet.purchases, [id]: { tier, quantity } } };
}
export function insertDemoToken(wallet: TokenWallet, id: string, tierValue: number): TokenWallet {
  const tier = tokenTier(tierValue);
  if (!validId(id) || Object.hasOwn(wallet.used, id)) throw new Error("Invalid or used play ID");
  if (wallet.pending) {
    if (wallet.pending.id === id && wallet.pending.tier === tier) return wallet;
    throw new Error("A token is already inserted");
  }
  if (wallet.balances[tier] < 1) throw new Error("No tokens of this type");
  const balances: [number, number, number] = [...wallet.balances]; balances[tier]--;
  return { ...wallet, balances, pending: { id, tier } };
}
export function ejectDemoToken(wallet: TokenWallet, id: string): TokenWallet {
  if (Object.hasOwn(wallet.used, id)) throw new Error("A played token cannot be returned");
  if (!wallet.pending || wallet.pending.id !== id) throw new Error("No matching inserted token");
  const balances: [number, number, number] = [...wallet.balances]; balances[wallet.pending.tier]++;
  return { ...wallet, balances, pending: null };
}
export function settleDemoToken(wallet: TokenWallet, id: string, prizeCents: number): TokenWallet {
  if (!validId(id) || !Number.isInteger(prizeCents) || prizeCents < 0) throw new Error("Invalid token result");
  if (Object.hasOwn(wallet.used, id)) {
    if (wallet.used[id].prizeCents !== prizeCents) throw new Error("Play ID reused with a different result");
    return wallet;
  }
  if (!CURRENT_PRIZES.has(prizeCents)) throw new Error("Invalid token result");
  if (!wallet.pending || wallet.pending.id !== id || Object.keys(wallet.used).length >= MAX_RECORDS) throw new Error("No matching token reservation");
  const tier = wallet.pending.tier;
  return { ...wallet, pending: null, used: { ...wallet.used, [id]: { tier, prizeCents } },
    totals: recordCompletedPlay(wallet.totals, prizeCents, TOKEN_TYPES[tier].priceCents) };
}
export function withdrawnPrizeCents(wallet: TokenWallet): number {
  return Object.values(wallet.withdrawals).reduce((sum, withdrawal) => sum + withdrawal.cents, 0);
}
export function availableWinningsCents(wallet: TokenWallet): number {
  return wallet.totals.prizeCents - withdrawnPrizeCents(wallet);
}
export function sessionWithdrawableCents(wallet: TokenWallet, sessionId: string, playIds: readonly string[]): number {
  const earned = [...new Set(playIds)].reduce((sum, id) => sum + (wallet.used[id]?.prizeCents ?? 0), 0);
  const withdrawn = Object.values(wallet.withdrawals).filter(item => item.sessionId === sessionId).reduce((sum, item) => sum + item.sessionCents, 0);
  return Math.max(0, Math.min(earned - withdrawn, availableWinningsCents(wallet)));
}
/** Demo ledger only. Recording a withdrawal never transfers USDC. */
export function withdrawDemoWinnings(wallet: TokenWallet, id: string, scope: WithdrawalScope, sessionId: string, playIds: readonly string[]): TokenWallet {
  if (!validId(id) || !validId(sessionId) || !["session", "all"].includes(scope)) throw new Error("Invalid withdrawal");
  if (Object.hasOwn(wallet.withdrawals, id)) {
    const prior = wallet.withdrawals[id];
    if (prior.scope !== scope || prior.sessionId !== sessionId) throw new Error("Withdrawal ID reused with different inputs");
    return wallet;
  }
  const sessionCents = sessionWithdrawableCents(wallet, sessionId, playIds);
  const cents = scope === "session" ? sessionCents : availableWinningsCents(wallet);
  if (!Number.isSafeInteger(cents) || cents <= 0 || Object.keys(wallet.withdrawals).length >= MAX_RECORDS) throw new Error("No winnings available");
  return { ...wallet, withdrawals: { ...wallet.withdrawals, [id]: { cents, sessionCents, sessionId, scope } } };
}
export function restoreTokenWallet(raw: string | null, legacyTotals: PlayerTotals = EMPTY_TOTALS): TokenWallet {
  if (!raw || raw.length > 2_000_000) return createTokenWallet(legacyTotals);
  try {
    const saved = JSON.parse(raw);
    if (saved.version !== 1 || !saved.baseTotals || typeof saved.purchases !== "object" || !saved.purchases || typeof saved.used !== "object" || !saved.used || Array.isArray(saved.purchases) || Array.isArray(saved.used)) throw new Error("Invalid wallet");
    const base = createTokenWallet(saved.baseTotals), balances: [number, number, number] = [0, 0, 0];
    const purchaseEntries = Object.entries(saved.purchases), usedEntries = Object.entries(saved.used);
    const purchases: Record<string, Purchase> = Object.create(null), used: Record<string, UsedToken> = Object.create(null);
    if (purchaseEntries.length > MAX_RECORDS || usedEntries.length > MAX_RECORDS) throw new Error("Oversized wallet");
    for (const [id, value] of purchaseEntries) {
      const item = value as Purchase;
      const tier = tokenTier(item.tier);
      if (!validId(id) || !isTokenQuantity(item.quantity)) throw new Error("Invalid purchase receipt");
      purchases[id] = { tier, quantity: item.quantity }; balances[tier] += item.quantity;
    }
    // Derive balances and totals from sanitized receipts instead of trusting saved counts.
    let totals = base.totals;
    for (const [id, value] of usedEntries) {
      const item = value as UsedToken;
      const tier = tokenTier(item.tier);
      if (!validId(id) || !HISTORICAL_PRIZES.has(item.prizeCents)) throw new Error("Invalid play receipt");
      used[id] = { tier, prizeCents: item.prizeCents }; balances[tier]--;
      totals = recordCompletedPlay(totals, item.prizeCents, TOKEN_TYPES[tier].priceCents);
    }
    let pending = null;
    if (saved.pending !== null) {
      const tier = tokenTier(saved.pending.tier), id = saved.pending.id;
      if (!validId(id) || Object.hasOwn(used, id)) throw new Error("Invalid inserted token");
      pending = { id, tier }; balances[tier]--;
    }
    if (!balances.every(value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_BALANCE)) throw new Error("Invalid token balance");
    const withdrawals: Record<string, Withdrawal> = Object.create(null);
    const savedWithdrawals = saved.withdrawals === undefined ? {} : saved.withdrawals;
    if (!savedWithdrawals || typeof savedWithdrawals !== "object" || Array.isArray(savedWithdrawals) || Object.keys(savedWithdrawals).length > MAX_RECORDS) throw new Error("Invalid withdrawals");
    let withdrawn = 0;
    for (const [id, value] of Object.entries(savedWithdrawals)) {
      const item = value as Withdrawal;
      if (!validId(id) || !validId(item.sessionId) || !["session", "all"].includes(item.scope)
        || !Number.isSafeInteger(item.cents) || item.cents <= 0 || !Number.isSafeInteger(item.sessionCents)
        || item.sessionCents < 0 || item.sessionCents > item.cents || (item.scope === "session" && item.sessionCents !== item.cents)) throw new Error("Invalid withdrawal receipt");
      withdrawn += item.cents;
      if (!Number.isSafeInteger(withdrawn) || withdrawn > totals.prizeCents) throw new Error("Withdrawal exceeds winnings");
      withdrawals[id] = { cents: item.cents, sessionCents: item.sessionCents, sessionId: item.sessionId, scope: item.scope };
    }
    return { ...base, balances, purchases, used, withdrawals, pending, totals };
  } catch { return createTokenWallet(legacyTotals); }
}
export const serializeTokenWallet = (wallet: TokenWallet) => JSON.stringify(wallet);
