import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveRoundPanel, timeLeftText } from './LiveRoundPanel';
import type { Round } from './api';

const NOW = 1_000_000;
const mock = vi.hoisted(() => ({ accountId: '0x' + 'a'.repeat(64) as string | undefined, rows: [] as any[], price: 101, ws: 'connected', paths: [] as (string | null)[] }));
vi.mock('@orderly.network/hooks', () => ({
  useAccount: () => ({ state: { status: mock.accountId ? 5 : 0, accountId: mock.accountId } }),
  useAccountInfo: () => ({ data: { futures_taker_fee_rate: 3 } }),
  useMarkPriceBySymbol: () => mock.price,
  useWsStatus: () => mock.ws,
}));
vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  useGameQuery: (path: string | null) => { mock.paths.push(path); return { data: path ? { rows: mock.rows } : undefined, error: '', refresh: vi.fn() }; },
}));

const live: Round = { id: 'r1', accountId: 'a', symbol: 'PERP_SOL_USDC', direction: 'UP', duration: 30, margin: 5, leverage: 20, quantity: 1,
  status: 'open', createdAt: NOW - 8000, openedAt: NOW - 7000, deadline: NOW + 23000, entryPrice: 100, liquidationPrice: 95.5 };
const closed: Round = { ...live, id: 'old', status: 'closed', closedAt: NOW - 60000, exitPrice: 99, tradingPnl: -1.06 };

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  mock.accountId = '0x' + 'a'.repeat(64); mock.rows = []; mock.price = 101; mock.ws = 'connected'; mock.paths = [];
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const render = () => act(() => root.render(<MemoryRouter><LiveRoundPanel/></MemoryRouter>));
const stat = (label: string) => [...container.querySelectorAll('.nl-live-round-stats > div')].find(d => d.querySelector('dt')!.textContent === label)?.querySelector('dd')!.textContent;

describe('live round panel', () => {
  it('renders nothing without an account or an active round', () => {
    mock.accountId = undefined; mock.rows = [live]; render();
    expect(container.innerHTML).toBe('');
    expect(mock.paths.at(-1)).toBeNull();
    mock.accountId = '0x' + 'a'.repeat(64); mock.rows = [closed]; render();
    expect(container.innerHTML).toBe('');
    expect(mock.paths.at(-1)).toBe(`/rounds?accountId=${mock.accountId}`);
  });

  it('shows the live round on one card with stats, a signed estimate and a countdown', () => {
    mock.rows = [live, closed]; render();
    const card = container.querySelector('.nl-live-round')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('.nl-live-round-market strong')!.textContent).toBe('SOL');
    expect(card.querySelector('.nl-live-round-call')!.textContent).toContain('Up');
    expect(card.querySelector('.nl-live-round-call')!.className).toContain('nl-positive');
    expect(stat('Bet')).toBe('$5.00');
    expect(stat('Leverage')).toBe('20×');
    expect(stat('Entry')).toBe('$100.00');
    expect(stat('Mark')).toBe('$101.00');
    // gross 1.00 − open 0.03 − exit 0.0303 at 3 bps
    const result = card.querySelector('.nl-live-round-result b')!;
    expect(result.textContent).toBe('+$0.94');
    expect(result.className).toContain('nl-positive');
    expect(card.querySelector('.nl-live-round-result small')!.textContent).toBe('estimate');
    expect(card.querySelector('.nl-live-round-clock')!.textContent).toBe('23s');
    expect((card.querySelector('.nl-live-round-bar i') as HTMLElement).style.width).toMatch(/^23.33/);
    const pill = card.querySelector('.nl-live-round-pill')!;
    expect(pill.textContent).toBe('Live');
    expect(pill.classList).toContain('nl-live-round-pill-live');
    const link = card.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/');
    expect(link.classList).toContain('nl-live-round-link');
    expect(link.textContent).toBe('Go to game →');
    // The right cluster reads link · clock · bar · pill in one row.
    expect([...card.querySelector('.nl-live-round-timer')!.children].map(el => el.className.split(' ')[0]))
      .toEqual(['nl-live-round-link', 'nl-live-round-clock', 'nl-live-round-bar', 'nl-live-round-pill']);
    expect(card.textContent).not.toContain('Liq');
    expect(card.querySelector('button')).toBeNull();
    for (const banned of ['fee', 'Fee', 'Funding', 'funding']) expect(card.textContent).not.toContain(banned);
  });

  it('signs a losing estimate and handles Down', () => {
    mock.rows = [{ ...live, direction: 'DOWN', liquidationPrice: undefined }]; render();
    expect(container.querySelector('.nl-live-round-call')!.textContent).toContain('Down');
    expect(container.querySelector('.nl-live-round-call')!.className).toContain('nl-negative');
    expect(container.textContent).not.toContain('Liq');
    const result = container.querySelector('.nl-live-round-result b')!;
    expect(result.textContent).toBe('-$1.06');
    expect(result.className).toContain('nl-negative');
  });

  it('shows a dash for the estimate while the price stream reconnects', () => {
    mock.ws = 'closed'; mock.rows = [{ ...live, markPrice: 100.5 }]; render();
    expect(stat('Mark')).toBe('$100.50');
    expect(container.querySelector('.nl-live-round-result b')!.textContent).toBe('—');
  });

  it('marks a closing round with the closing pill', () => {
    mock.rows = [{ ...live, status: 'closing' }]; render();
    const pill = container.querySelector('.nl-live-round-pill')!;
    expect(pill.textContent).toBe('Closing');
    expect(pill.classList).toContain('nl-live-round-pill-closing');
    expect(pill.classList).not.toContain('nl-live-round-pill-live');
  });

  it('shows the opening state until the entry fill and deadline exist', () => {
    mock.rows = [{ ...live, status: 'opening', entryPrice: undefined, openedAt: undefined, deadline: undefined }]; render();
    const card = container.querySelector('.nl-live-round')!;
    expect(card.textContent).toContain('Opening your round…');
    expect(card.querySelector('.nl-live-round-stats')).toBeNull();
    expect(card.querySelector('.nl-live-round-clock')).toBeNull();
    expect(card.querySelector('.nl-live-round-bar')).toBeNull();
    expect(card.querySelector('.nl-live-round-pill')!.className).toContain('nl-live-round-pill-opening');
    expect(card.querySelector('.nl-live-round-link')!.getAttribute('href')).toBe('/');
    for (const banned of ['fee', 'Fee', 'Funding', 'funding']) expect(card.textContent).not.toContain(banned);
  });

  it('reads the countdown like the game screen: "4m 05s", seconds only under a minute', () => {
    expect([0, 5, 44.2, 59.9, 60, 65, 272, 300, 3900, NaN].map(timeLeftText))
      .toEqual(['0s', '5s', '45s', '1m 00s', '1m 00s', '1m 05s', '4m 32s', '5m 00s', '65m 00s', '0s']);
  });
});
