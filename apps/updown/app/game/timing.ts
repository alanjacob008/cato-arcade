export const roundDurations = [[300, '5m'], [600, '10m'], [900, '15m'], [1800, '30m']] as const;
export const defaultRoundDuration = 900;
/** Longest a round may run in total, including added time (mirrors MAX_ROUND_DURATION in server/engine.mjs). */
export const maxRoundDuration = 7200;

/** "2:05 PM" / "14:05" — the wall-clock moment a deadline lands on, in the player's locale. */
export function clockTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "5 min", "30 min" — the round length as players read it. */
export function durationText(seconds: number) {
  return seconds % 60 ? `${seconds} sec` : `${seconds / 60} min`;
}

export function countdown(seconds: number) {
  const whole = Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
