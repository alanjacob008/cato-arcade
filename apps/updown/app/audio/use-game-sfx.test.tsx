import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIG_WIN_RATIO, resultSfx, TICK_FINAL_FROM, TICK_FROM, useGameSfx, type GameSfxState } from './use-game-sfx';
import type { SfxEngine } from './sfx';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function harness() {
  const play = vi.fn();
  const engine = { play } as unknown as SfxEngine;
  function Probe({ state }: { state: GameSfxState }) { useGameSfx(state, engine); return null; }
  const render = (state: GameSfxState) => act(() => root.render(<Probe state={state}/>));
  return { play, render, names: () => play.mock.calls.map((c) => c[0]) };
}

describe('resultSfx', () => {
  it('picks the big payout from half the stake up, the plain one below, loss for red, nothing for flat', () => {
    expect(BIG_WIN_RATIO).toBe(0.5);
    expect(resultSfx(5, 10)).toBe('win-big');
    expect(resultSfx(4.99, 10)).toBe('win');
    expect(resultSfx(50, 10)).toBe('win-big');
    expect(resultSfx(0.01, 10)).toBe('win');
    // without a usable stake it can only be the plain win
    expect(resultSfx(5)).toBe('win');
    expect(resultSfx(5, 0)).toBe('win');
    expect(resultSfx(-0.01, 10)).toBe('loss');
    expect(resultSfx(-50, 10)).toBe('loss');
    expect(resultSfx(0, 10)).toBeNull();
    expect(resultSfx(null, 10)).toBeNull();
    expect(resultSfx(undefined, 10)).toBeNull();
    expect(resultSfx(Number.NaN, 10)).toBeNull();
  });
});

describe('useGameSfx', () => {
  it('ka-chings once when the round fills, then wins or loses once when it closes', () => {
    const h = harness();
    h.render({ filled: false });
    h.render({ activeId: 'r1', filled: false });
    expect(h.names()).toEqual([]);
    h.render({ activeId: 'r1', filled: true });
    h.render({ activeId: 'r1', filled: true });
    expect(h.names()).toEqual(['filled']);
    h.render({ filled: false, last: { id: 'r1', result: null, stake: 10 } });
    expect(h.names()).toEqual(['filled']);
    h.render({ filled: false, last: { id: 'r1', result: 2.5, stake: 10 } });
    h.render({ filled: false, last: { id: 'r1', result: 2.5, stake: 10 } });
    expect(h.names()).toEqual(['filled', 'win']);
    h.render({ activeId: 'r2', filled: true });
    h.render({ filled: false, last: { id: 'r2', result: -1, stake: 10 } });
    expect(h.names()).toEqual(['filled', 'win', 'filled', 'loss']);
    h.render({ filled: false, last: { id: 'r3', result: 0, stake: 10 } });
    expect(h.names()).toEqual(['filled', 'win', 'filled', 'loss']);
  });

  it('plays the big payout when the win is at least half the stake', () => {
    const h = harness();
    h.render({ filled: false });
    h.render({ filled: false, last: { id: 'r1', result: 5, stake: 10 } });
    expect(h.names()).toEqual(['win-big']);
    h.render({ filled: false, last: { id: 'r2', result: 4.9, stake: 10 } });
    expect(h.names()).toEqual(['win-big', 'win']);
    // an unknown stake never claims the big one
    h.render({ filled: false, last: { id: 'r3', result: 100 } });
    expect(h.names()).toEqual(['win-big', 'win', 'win']);
  });

  it('is silent about what was already there when the page loaded', () => {
    const h = harness();
    h.render({ activeId: 'r1', filled: true, last: { id: 'r0', result: 4, stake: 1 } });
    expect(h.names()).toEqual([]);
    const h2 = harness();
    h2.render({ filled: false, last: { id: 'r0', result: -4, stake: 1 } });
    expect(h2.names()).toEqual([]);
  });

  it('ticks once per second through the last ten seconds, the final three with the brighter tick', () => {
    expect(TICK_FROM).toBe(10);
    expect(TICK_FINAL_FROM).toBe(3);
    const h = harness();
    for (const s of [12, 11, 10, 10, 9, 9, 8, 4, 3, 2, 1, 1, 0]) h.render({ activeId: 'r1', filled: true, remaining: s });
    expect(h.names()).toEqual(['tick', 'tick', 'tick', 'tick', 'tick-final', 'tick-final', 'tick-final']);
    const gains = h.play.mock.calls.filter((c) => c[0] === 'tick').map((c) => (c[1] as { gain: number }).gain);
    expect(gains[0]).toBeLessThan(gains[3]);
    // not while waiting for the fill, nor after the round
    h.render({ activeId: 'r2', filled: false, remaining: 2 });
    h.render({ filled: false, remaining: 2 });
    expect(h.names()).toHaveLength(7);
  });
});
