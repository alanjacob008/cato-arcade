import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Rounds from './Rounds';
import type { Round } from './api';

const mock = vi.hoisted(() => ({ accountId: '0x' + 'a'.repeat(64) as string | undefined, rows: [] as any[], history: [] as any[], error: '' }));
vi.mock('@orderly.network/hooks', () => ({ useAccount: () => ({ state: { status: mock.accountId ? 5 : 0, accountId: mock.accountId } }), usePrivateQuery: () => ({ data: mock.history }) }));
vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  useGameQuery: (path: string | null) => ({ data: path ? { rows: mock.rows } : undefined, error: mock.error, refresh: vi.fn() }),
}));

const closed: Round = { id: 'r1', accountId: 'a', symbol: 'PERP_SOL_USDC', direction: 'UP', duration: 30, margin: 5, leverage: 20, quantity: 1,
  status: 'closed', createdAt: Date.now() - 60000, closedAt: Date.now(), entryPrice: 100, exitPrice: 100.0412, fees: .06, tradingPnl: -0.0188 };

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mock.accountId = '0x' + 'a'.repeat(64); mock.rows = []; mock.history = []; mock.error = '';
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = () => act(() => root.render(<Rounds/>));
const headers = () => [...container.querySelectorAll('thead th')].map(th => th.textContent);

describe('rounds history', () => {
  it('recovers an older liquidation and includes its actual loss in the row, totals and win rate', () => {
    const ended = { ...closed, id: 'liquidated', status: 'ended_early', createdAt: Date.now() - 100000, openedAt: Date.now() - 99000,
      closedAt: Date.now(), exitPrice: undefined, tradingPnl: undefined, quantity: 1, margin: 10 };
    mock.rows = [ended, { ...closed, id: 'won', tradingPnl: 1, exitPrice: 101 }];
    mock.history = [{ position_id: 123, position_status: 'closed', type: 'liquidated', margin_mode: 'ISOLATED', symbol: ended.symbol,
      side: 'LONG', max_position_qty: 1, closed_position_qty: 1, avg_open_price: 100, avg_close_price: 92,
      open_timestamp: ended.openedAt, close_timestamp: ended.closedAt - 1000, realized_pnl: -9, trading_fee: .06, accumulated_funding_fee: .01 }];
    render();
    expect(container.querySelector('tbody tr .nl-rounds-result')?.textContent).toBe('-$9.07');
    expect(container.querySelector('tbody tr .nl-rounds-status')?.textContent).toBe('Liquidated');
    expect([...container.querySelectorAll('.nl-rounds-stat')].map(s => s.textContent)).toEqual(['All-time result-$8.07', 'Today-$8.07', 'Wins1 / 250%']);
  });
  it('shows one result per round and never mentions fee amounts, funding or price PnL', () => {
    mock.rows = [closed]; render();
    expect(headers()).toEqual(['Market', 'Trade time', 'Game time', 'Bet', 'Leverage', 'Entry', 'Exit', 'Price move', 'Result', 'Status']);
    const row = container.querySelector('tbody tr')!;
    const cells = [...row.querySelectorAll('td')].map(td => td.textContent);
    expect(cells.slice(2, 8)).toEqual(['30s', '$5.00', '20×', '$100.00', '$100.04', '+0.04%']);
    expect(row.querySelector('.nl-rounds-result')!.textContent).toBe('-$0.02');
    expect(row.querySelector('.nl-rounds-result')!.className).toContain('nl-negative');
    expect(row.textContent).toContain('Up');
    expect(row.textContent).not.toContain('UP');
    expect(row.textContent).not.toContain('·');
    expect(cells[7]).toBe('+0.04%');
    expect(cells[7]).not.toMatch(/Up|Down|Flat/);
    expect(row.querySelector('.nl-rounds-move')!.className).toContain('nl-positive');
    expect(row.querySelector('small')).toBeNull();
    expect(row.textContent).not.toMatch(/Rose|Fell/);
    expect(row.querySelector('.nl-rounds-status')).toBeNull();
    // The only allowed mention of fees is the "after fees" tag; strip it and nothing fee-related may remain.
    const copy = container.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.nl-rounds-fee-tag').forEach(tag => tag.remove());
    const text = copy.textContent!;
    for (const banned of ['Funding', 'funding', 'fee', 'Fee', 'Trading fees', 'Price PnL', 'Net trading']) expect(text).not.toContain(banned);
    expect(container.textContent).not.toMatch(/Trading fees|Funding|funding/);
    expect(container.querySelector('[title*="fee"]:not(.nl-rounds-fee-tag)')).toBeNull();
  });

  it('tags a right call that fees turned into a loss with "after fees" in the Status cell, leaving Result as the bare amount', () => {
    const won = { ...closed, id: 'won', exitPrice: 101, tradingPnl: 0.94 };
    const wrong = { ...closed, id: 'wrong', exitPrice: 99.5, tradingPnl: -0.56 };
    const downErased = { ...closed, id: 'down-erased', direction: 'DOWN' as const, exitPrice: 99.9588, tradingPnl: -0.0188 };
    const downWrong = { ...closed, id: 'down-wrong', direction: 'DOWN' as const, tradingPnl: -0.1 };
    const open = { ...closed, id: 'open', status: 'open', exitPrice: undefined, tradingPnl: undefined };
    mock.rows = [closed, won, wrong, downErased, downWrong, open]; render();
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows.map(r => Boolean(r.querySelector('.nl-rounds-fee-tag')))).toEqual([true, false, false, true, false, false]);
    expect(container.querySelectorAll('.nl-rounds-fee-tag')).toHaveLength(2);
    const result = rows[0].querySelectorAll('td')[8];
    expect(result.textContent).toBe('-$0.02');
    expect(result.querySelector('.nl-rounds-fee-tag')).toBeNull();
    expect([...result.children].map(c => c.className)).toEqual(['nl-rounds-result nl-negative']);
    const status = rows[0].querySelectorAll('td')[9];
    expect(status.textContent).toBe('after fees');
    const tag = status.querySelector(':scope > .nl-rounds-fee-tag')!;
    expect(tag.textContent).toBe('after fees');
    expect(tag.getAttribute('title')).toBe('The price moved your way, but trading fees were larger than the gain.');
    expect(rows[3].querySelectorAll('td')[8].textContent).toBe('-$0.02');
    expect(rows[3].querySelectorAll('td')[9].textContent).toBe('after fees');
    expect(rows[1].querySelectorAll('td')[8].textContent).toBe('+$0.94');
    expect(rows[2].querySelectorAll('td')[8].textContent).toBe('-$0.56');
    for (const i of [1, 2, 4]) expect(rows[i].querySelectorAll('td')[9].textContent).toBe('');
    expect(rows[5].querySelectorAll('td')[9].textContent).toBe('Live');
    const text = container.textContent!.replaceAll('after fees', '');
    expect(text).not.toMatch(/fee|Fee|Funding|funding/);
  });

  it('gives the status column a visible header, leaves normal closed rounds blank and pills the rest', () => {
    const won = { ...closed, id: 'won', exitPrice: 101, tradingPnl: 0.94 };
    mock.rows = [won, { ...closed, id: 'open', status: 'open', exitPrice: undefined, tradingPnl: undefined },
      { ...closed, id: 'closing', status: 'closing', exitPrice: undefined, tradingPnl: undefined },
      { ...closed, id: 'failed', status: 'failed', tradingPnl: undefined, error: 'Rejected' },
      { ...closed, id: 'early', status: 'ended_early', tradingPnl: undefined }];
    render();
    const th = [...container.querySelectorAll('thead th')].at(-1)!;
    expect(th.textContent).toBe('Status');
    expect(th.children.length).toBe(0);
    expect(th.classList).toContain('nl-rounds-status-col');
    expect(th.classList).not.toContain('nl-rounds-num');
    expect(container.querySelector('.nl-rounds-visually-hidden')).toBeNull();
    const cells = [...container.querySelectorAll('tbody tr')].map(r => r.querySelectorAll('td')[9]);
    expect(cells.map(c => c.textContent)).toEqual(['', 'Live', 'Closing', 'Failed', 'Confirming result']);
    expect(cells[0].children.length).toBe(0);
    expect(container.textContent).not.toContain('Done');
    expect(cells[1].querySelector('.nl-rounds-status-live')).not.toBeNull();
    expect(cells[2].querySelector('.nl-rounds-status-closing')).not.toBeNull();
    expect(cells[3].querySelector('.nl-rounds-status-ended')!.getAttribute('title')).toBe('Rejected');
    expect(cells[4].querySelector('.nl-rounds-status-ended')).not.toBeNull();
  });

  it('right-aligns numeric headers and cells together, text columns stay left', () => {
    mock.rows = [closed]; render();
    const numeric = (el: Element) => el.classList.contains('nl-rounds-num');
    expect([...container.querySelectorAll('thead th')].map(numeric)).toEqual([false, false, false, true, true, true, true, true, true, false]);
    expect([...container.querySelectorAll('tbody tr:first-child td')].map(numeric)).toEqual([false, false, false, true, true, true, true, true, true, false]);
  });

  it('sums the stat cards from closed rounds and counts wins', () => {
    mock.rows = [closed, { ...closed, id: 'r2', tradingPnl: 1.5 }, { ...closed, id: 'r3', status: 'failed', tradingPnl: undefined, error: 'Rejected' }];
    render();
    const stats = [...container.querySelectorAll('.nl-rounds-stat')].map(s => s.textContent);
    expect(stats[0]).toBe('All-time result$1.48');
    expect(stats[1]).toBe('Today$1.48');
    expect(stats[2]).toBe('Wins1 / 250%');
    // Shared with the Balances tab so the tiles keep one size across tabs.
    expect(container.querySelectorAll('.nl-stat-tiles > .nl-stat-tile.nl-rounds-stat')).toHaveLength(3);
    expect(container.querySelector('.nl-stat-tiles + .nl-stat-caption')).not.toBeNull();
    const failed = container.querySelectorAll('tbody tr')[2];
    expect(failed.querySelector('.nl-rounds-status')!.textContent).toBe('Failed');
    expect(failed.querySelector('.nl-rounds-status')!.getAttribute('title')).toBe('Rejected');
    expect(failed.querySelector('.nl-rounds-result')!.textContent).toBe('—');
  });

  it('writes the price move as a signed two-decimal percent only, with matching colour', () => {
    mock.rows = [closed, { ...closed, id: 'down', exitPrice: 99.5, tradingPnl: -0.5 }, { ...closed, id: 'flat', exitPrice: 100, tradingPnl: -0.06 },
      { ...closed, id: 'tiny', exitPrice: 99.999, tradingPnl: -0.001 }];
    render();
    const moves = [...container.querySelectorAll('.nl-rounds-move')];
    expect(moves.map(m => m.textContent)).toEqual(['+0.04%', '-0.50%', '0.00%', '0.00%']);
    expect(moves.every(m => m.children.length === 0)).toBe(true);
    expect(moves[0].className).toContain('nl-positive');
    expect(moves[1].className).toContain('nl-negative');
    expect(moves[2].className).not.toMatch(/nl-positive|nl-negative/);
    expect(moves[3].className).not.toMatch(/nl-positive|nl-negative/);
    const results = [...container.querySelectorAll('.nl-rounds-result')];
    expect(results.map(r => r.textContent)).toEqual(['-$0.02', '-$0.50', '-$0.06', '$0.00']);
    expect(results[3].className).not.toMatch(/nl-positive|nl-negative/);
  });

  it('limits prices, bet and result to two decimals', () => {
    mock.rows = [{ ...closed, margin: 12.345, entryPrice: 0.123456, exitPrice: 64123.456789, tradingPnl: 3.14159 }];
    render();
    const cells = [...container.querySelectorAll('tbody td')].map(td => td.textContent);
    expect(cells[3]).toBe('$12.35');
    expect(cells[5]).toBe('$0.12');
    expect(cells[6]).toBe('$64,123.46');
    expect(cells[8]).toBe('+$3.14');
  });

  it('puts icon, ticker and direction call on one line in the market cell', () => {
    mock.rows = [closed, { ...closed, id: 'd', direction: 'DOWN' }]; render();
    const cell = container.querySelector('tbody td')!;
    const market = cell.querySelector(':scope > .nl-rounds-market')!;
    expect([...market.children].map(c => c.tagName)).toEqual(['SPAN', 'STRONG', 'SPAN']);
    expect(market.children[0].className).toBe('nl-coin');
    expect(market.querySelector('strong')!.textContent).toBe('SOL');
    expect(market.querySelector('.nl-rounds-call')!.textContent).toBe('↗ Up');
    expect(cell.textContent).toContain('SOL');
    expect(cell.textContent).toContain('Up');
    expect(cell.querySelector('.nl-rounds-market-text')).toBeNull();
    expect(cell.querySelector('.nl-history-market')).toBeNull();
    expect(container.querySelectorAll('tbody tr')[1].querySelector('.nl-rounds-call')!.textContent).toBe('↘ Down');
  });

  describe('trade time and game time columns', () => {
    const now = new Date(2026, 9, 9, 14, 32, 0);
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
    afterEach(() => vi.useRealTimers());
    const timeCell = () => container.querySelector('tbody td.nl-rounds-time')!;
    const when = () => timeCell().textContent!;
    const gameTime = () => container.querySelector('tbody td.nl-rounds-duration')!.textContent;
    const fmt = (t: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, o).format(t);

    it('shows only the local clock time for rounds played today', () => {
      const createdAt = new Date(2026, 9, 9, 9, 5).getTime();
      mock.rows = [{ ...closed, createdAt, closedAt: createdAt + 30000 }]; render();
      expect(when()).toBe(fmt(createdAt, { hour: '2-digit', minute: '2-digit' }));
      expect(when()).toMatch(/09:05/);
      expect(when()).not.toMatch(/Oct|2026|\d{4}/);
      expect(timeCell().querySelector('small')).toBeNull();
      expect(timeCell().children.length).toBe(0);
      expect(gameTime()).toBe('30s');
    });

    it('adds a short day and month for rounds played on another day', () => {
      const createdAt = new Date(2026, 9, 1, 23, 45).getTime();
      mock.rows = [{ ...closed, duration: 180, createdAt, closedAt: createdAt + 180000 }]; render();
      expect(when()).toBe(fmt(createdAt, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
      expect(when()).toMatch(/Oct/);
      expect(when()).toMatch(/\b1\b/);
      expect(when()).toMatch(/11:45|23:45/);
      expect(when()).not.toMatch(/2026/);
      expect(gameTime()).toBe('3m');
    });

    it('does not count rounds from another day in the Today card', () => {
      // The shared fixture is stamped with the real clock at import time; pin it to the fake 'now'.
      const today = { ...closed, createdAt: now.getTime() - 60000, closedAt: now.getTime() };
      mock.rows = [today, { ...closed, id: 'old', createdAt: now.getTime() - 86400000 * 3, closedAt: now.getTime() - 86400000 * 3, tradingPnl: 5 }];
      render();
      const stats = [...container.querySelectorAll('.nl-rounds-stat')].map(s => s.textContent);
      expect(stats[0]).toBe('All-time result$4.98');
      expect(stats[1]).toBe('Today-$0.02');
    });
  });

  it('marks active rounds as live', () => {
    mock.rows = [{ ...closed, id: 'r4', status: 'open', exitPrice: undefined, tradingPnl: undefined }];
    render();
    expect(container.querySelector('.nl-rounds-status-live')!.textContent).toBe('Live');
  });

  it('keeps the empty state and wallet prompt', () => {
    mock.accountId = undefined; render();
    expect(container.querySelector('.nl-empty img')!.getAttribute('src')).toBe('/updown/cato/waiting.webp');
    expect(container.textContent).toContain('Connect your wallet to see your rounds.');
    expect([...container.querySelectorAll('.nl-rounds-stat strong')].map(s => s.textContent)).toEqual(['—', '—', '—']);
  });

  it('shows the error alert', () => {
    mock.error = 'Round service is offline.'; render();
    expect(container.querySelector('[role=alert]')!.textContent).toBe('Round service is offline.');
  });
});
