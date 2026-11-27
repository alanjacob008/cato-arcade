// Round sounds from the game's derived state: a ka-ching when the round reports its fill, a payout / loss sting when
// it closes with a result (the big payout when the win is at least half the stake), and a clock tick each second
// through the last ten (a higher, louder one at 3-2-1). The click sounds (UP / DOWN / close early) are played by the
// handlers themselves. Only transitions make noise: a page loaded mid-round stays quiet.
import { useEffect, useRef } from 'react';
import { sfx as defaultEngine, type SfxEngine, type SfxName } from './sfx';

export interface GameSfxState {
  /** the active round's id, if any */
  activeId?: string;
  /** the active round is open with an entry price */
  filled: boolean;
  /** the latest finished round: its id, net result (undefined while unreconciled) and stake (the margin put up) */
  last?: { id: string; result?: number | null; stake?: number };
  /** seconds left on the active round's clock (whole seconds), when it is open */
  remaining?: number;
}

/** ticks start this many seconds before the deadline */
export const TICK_FROM = 10;
/** the last seconds get the brighter tick */
export const TICK_FINAL_FROM = 3;
/** a win of at least this share of the stake gets the big payout */
export const BIG_WIN_RATIO = 0.5;

/** Which sting a finished round earns, or null for a flat / unknown result. */
export function resultSfx(result: number | null | undefined, stake?: number): SfxName | null {
  if (result == null || result === 0 || !Number.isFinite(result)) return null;
  if (result < 0) return 'loss';
  return stake != null && stake > 0 && result / stake >= BIG_WIN_RATIO ? 'win-big' : 'win';
}

export function useGameSfx(state: GameSfxState, engine: SfxEngine = defaultEngine) {
  const { activeId, filled, last, remaining } = state;
  const seen = useRef<{ filled?: string; closed?: string; tick?: string; init: boolean }>({ init: false });

  // first render: remember what is already there, so nothing replays on reload
  if (!seen.current.init) {
    seen.current = { init: true, filled: filled ? activeId : undefined, closed: last?.result != null ? last.id : undefined };
  }

  useEffect(() => {
    if (filled && activeId && seen.current.filled !== activeId) {
      seen.current.filled = activeId;
      engine.play('filled');
    }
  }, [filled, activeId, engine]);

  useEffect(() => {
    if (!last || last.result == null || seen.current.closed === last.id) return;
    seen.current.closed = last.id;
    const name = resultSfx(last.result, last.stake);
    if (name) engine.play(name);
  }, [last, engine]);

  useEffect(() => {
    if (!filled || !activeId || remaining == null || remaining > TICK_FROM || remaining <= 0) return;
    const key = `${activeId}:${remaining}`;
    if (seen.current.tick === key) return;
    seen.current.tick = key;
    if (remaining <= TICK_FINAL_FROM) engine.play('tick-final');
    else engine.play('tick', { gain: 0.7 + (TICK_FROM - remaining) * 0.04 });
  }, [filled, activeId, remaining, engine]);
}
