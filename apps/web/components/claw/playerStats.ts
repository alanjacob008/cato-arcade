// Local demo bookkeeping. Entry costs use the USD value locked for the play.
export type PlayerTotals = Readonly<{ prizeCents: number; entryCents: number }>;
export const EMPTY_TOTALS: PlayerTotals = Object.freeze({ prizeCents: 0, entryCents: 0 });
export const playerTotalsKey = (playerId: string) => `cato-claw-demo-totals-v1:${playerId}`;

const validCents = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function restorePlayerTotals(raw: string | null): PlayerTotals {
  if (!raw) return EMPTY_TOTALS;
  try {
    const saved = JSON.parse(raw);
    if (saved?.version === 1 && validCents(saved.prizeCents) && validCents(saved.entryCents)) {
      return { prizeCents: saved.prizeCents, entryCents: saved.entryCents };
    }
  } catch { /* Discard incomplete or invalid demo storage. */ }
  return EMPTY_TOTALS;
}

export function recordCompletedPlay(previous: PlayerTotals, prizeCents: number, entryCents: number): PlayerTotals {
  const next = { prizeCents: previous.prizeCents + prizeCents, entryCents: previous.entryCents + entryCents };
  if (![previous.prizeCents, previous.entryCents, prizeCents, entryCents, next.prizeCents, next.entryCents].every(validCents)) {
    throw new Error("Invalid demo play totals");
  }
  return next;
}

export const serializePlayerTotals = (totals: PlayerTotals) => JSON.stringify({ version: 1, ...totals });
