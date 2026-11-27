import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Game from './Game';
import { catPose, CAT_REACTION_MS } from './cat-pose';
import { clearSeries, recordPnl } from './chart-series';
import { GAME_SYMBOL } from './market.mjs';

const mock = vi.hoisted(() => ({ status: 0, price: 100, collateral: 100, ws: 'connected', rows: [] as any[], health: { ready: true, network: 'testnet', timeExtensions: true } as any, healthError: '', createKey: vi.fn(), api: vi.fn(), connect: vi.fn(), show: vi.fn(), mobile: false }));
vi.mock('./device-authorization', () => ({ getDeviceAuthorization: (...args: unknown[]) => mock.createKey(...args) }));
vi.mock('@orderly.network/hooks', () => ({
  useAccount: () => ({ state: { status: mock.status, accountId: mock.status ? '0x' + 'a'.repeat(64) : undefined }, account: { createApiKey: mock.createKey }, isSubAccount: false }),
  useAccountInfo: () => ({ data: { futures_taker_fee_rate: 3 } }),
  useCollateral: () => ({ freeCollateral: mock.collateral, freeCollateralUSDCOnly: mock.collateral, usdcHolding: mock.collateral }),
  useOrderbookStream: () => [{ asks: [[mock.price, 100]], bids: [[mock.price, 100]] }],
  useMarkPriceBySymbol: () => mock.price,
  useWsStatus: () => mock.ws,
  usePrivateQuery: () => ({ data: undefined }),
  useWalletConnector: () => ({ connect: (...args: unknown[]) => mock.connect(...args) }),
}));
vi.mock('@orderly.network/ui', () => ({ modal: { show: (...args: unknown[]) => mock.show(...args) }, useScreen: () => ({ isMobile: mock.mobile }) }));
vi.mock('@orderly.network/ui-transfer', () => ({ DepositAndWithdrawWithDialogId: 'deposit-dialog', DepositAndWithdrawWithSheetId: 'deposit-sheet' }));
vi.mock('./BalanceBar', () => ({ BalanceBar: () => <div>Account balance</div> }));
vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(),
  gameApi: (...args: unknown[]) => mock.api(...args),
  useGameQuery: (path: string | null) => ({
    // The service only lists BTC; a stray extra row must never become playable.
    data: path === '/markets' ? { rows: [
      { symbol: 'PERP_BTC_USDC', display_symbol_name: 'BTC', maxLeverage: 100, base_imr: .01, imr_factor: .000001, base_min: .01, base_tick: .01, min_notional: 10, mark_price: 100, '24h_open': 95, '24h_close': 100, '24h_amount': 1234567 },
      { symbol: 'PERP_SOL_USDC', maxLeverage: 50, base_imr: .02, imr_factor: .000001, base_min: .01, base_tick: .01, min_notional: 10, mark_price: 100 },
    ] } : path === '/health' ? mock.health : { rows: mock.rows },
    error: path === '/health' ? mock.healthError : '', refresh: vi.fn(),
  }),
}));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mock.status = 0; mock.price = 100; mock.collateral = 100; mock.ws = 'connected'; mock.rows = []; mock.health = { ready: true, network: 'testnet', timeExtensions: true }; mock.healthError = ''; mock.mobile = false;
  mock.createKey.mockReset(); mock.api.mockReset(); mock.connect.mockReset(); mock.show.mockReset();
  clearSeries(); localStorage.clear();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const render = () => act(() => root.render(<MemoryRouter><Game/></MemoryRouter>));
const chart = () => container.querySelector('.nl-pnl-chart')!;
describe('game interactions', () => {
  it.each([600, 1800])('formats the active timer and authorizes a %s-second extension through the worker', async seconds => {
    vi.spyOn(Date, 'now').mockReturnValue(200000);
    mock.status = 5;
    const accountId = '0x' + 'a'.repeat(64);
    mock.rows = [{ id: 'round-extend', accountId, status: 'open', symbol: GAME_SYMBOL, direction: 'UP', duration: 180, leverage: 100, margin: 5, quantity: 1, entryPrice: 100, openedAt: Date.now() - 105000, deadline: Date.now() + 75000 }];
    render();
    expect(container.querySelector('.nl-countdown .nl-time-left')?.textContent).toBe('1m 15s');
    expect(container.querySelector('.nl-round-strip b')?.textContent).toBe('1m 15s remaining');
    // Add time sits in the round controls under the timer from the start, with more than a minute left.
    expect(container.querySelector('.nl-round-controls .nl-extension')).not.toBeNull();
    mock.rows = [{ ...mock.rows[0], deadline: Date.now() + 45000 }]; render();
    expect(container.querySelector('.nl-countdown .nl-time-left')?.textContent).toBe('45s');
    mock.createKey.mockResolvedValue({ secretKey: 'extension-test-key', key: 'public-test-key' });
    mock.api.mockResolvedValue({ ...mock.rows[0], deadline: Date.now() + 45000 + seconds * 1000 });
    // No popover: the four chips are always on screen.
    expect(container.querySelector('.nl-extension-pop')).toBeNull();
    expect(container.querySelector('.nl-round-controls .nl-extension .nl-duration')).not.toBeNull();
    expect([...container.querySelectorAll('.nl-extension .nl-duration button')].map(b => b.textContent)).toEqual(['+5m', '+10m', '+15m', '+30m']);
    const choice = [...container.querySelectorAll<HTMLButtonElement>('.nl-extension .nl-duration button')].find(button => button.textContent === `+${seconds / 60}m`)!;
    await act(async () => choice.click());
    expect(mock.createKey).toHaveBeenCalledOnce();
    expect(mock.api).toHaveBeenCalledWith('/rounds/round-extend/extend', { id: expect.stringMatching(/^[a-zA-Z0-9_-]{8,48}$/), seconds, accountId, secretKey: 'extension-test-key' });
    // The UI waits for journal polling instead of inventing a later countdown.
    expect(container.querySelector('.nl-countdown .nl-time-left')?.textContent).toBe('45s');
    mock.rows = [{ ...mock.rows[0], duration: 180 + seconds, deadline: Date.now() + 45000 + seconds * 1000 }]; render();
    expect(container.querySelector('.nl-countdown .nl-time-left')?.textContent).toBe(`${seconds / 60}m 45s`);
    expect(container.querySelector('.nl-round-controls .nl-extension')).not.toBeNull();
  });
  it('keeps Add time and Close round early together under the timer for the whole round', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(200000);
    mock.status = 5;
    mock.rows = [{ id: 'round-4m', accountId: '0x' + 'a'.repeat(64), status: 'open', symbol: GAME_SYMBOL, direction: 'UP', duration: 300, leverage: 100, margin: 5, quantity: 1, entryPrice: 100, openedAt: Date.now() - 60000, deadline: Date.now() + 240000 }];
    render();
    expect(container.querySelector('.nl-countdown .nl-time-left')?.textContent).toBe('4m 00s');
    const controls = container.querySelector('.nl-round-controls')!;
    expect(controls).not.toBeNull();
    // Order inside the panel: timer (with its progress bar), then the controls block, then the live result.
    const panel = container.querySelector('.nl-active-round')!;
    const order = [...panel.children].map(child => child.className);
    expect(order.indexOf('nl-active-hero')).toBeLessThan(order.indexOf('nl-round-controls'));
    expect(order.indexOf('nl-round-controls')).toBeLessThan(order.indexOf('nl-result-card'));
    expect(container.querySelector('.nl-active-hero progress')).not.toBeNull();
    expect([...controls.querySelectorAll('.nl-extension .nl-duration button')].map(b => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual([['+5m', false], ['+10m', false], ['+15m', false], ['+30m', false]]);
    const close = controls.querySelector<HTMLButtonElement>('.nl-close-early')!;
    expect(close.textContent).toBe('Close round early');
    expect(close.disabled).toBe(false);
    expect(controls.lastElementChild).toBe(close);
    // No confirmation step: one click sends the close and shows a short closing state while the request is in flight.
    let settle!: () => void;
    mock.api.mockImplementation(() => new Promise<void>(resolve => { settle = resolve; }));
    await act(async () => { close.click(); });
    expect(mock.api).toHaveBeenCalledWith('/rounds/round-4m/close', {});
    expect(container.querySelector('[aria-label="Close confirmation"]')).toBeNull();
    expect(close.textContent).toBe('Closing…');
    expect(close.disabled).toBe(true);
    await act(async () => settle());
    expect(close.textContent).toBe('Close round early');
  });
  it('heads the active round with "Your call" and a direction arrow, never the coin or ticker', () => {
    vi.spyOn(Date, 'now').mockReturnValue(200000);
    mock.status = 5;
    mock.rows = [{ id: 'round', status: 'open', symbol: GAME_SYMBOL, direction: 'DOWN', duration: 300, leverage: 100, margin: 1, quantity: 1, entryPrice: 100, deadline: Date.now() + 272000 }];
    render();
    const head = container.querySelector('.nl-active-head')!;
    expect(head.querySelector('.nl-coin')).toBeNull();
    expect(head.querySelector('h2')?.textContent).toBe('Your call');
    expect(head.querySelector('.nl-active-direction.nl-negative svg')).not.toBeNull();
    expect(head.textContent).toBe('Your call');
    expect(container.textContent).not.toMatch(/BTC|bitcoin|\d+×/i);
    expect(container.querySelector('.nl-countdown .nl-time-left')?.textContent).toBe('4m 32s');
    mock.rows = [{ ...mock.rows[0], direction: 'UP', deadline: Date.now() + 245000 }]; render();
    expect(container.querySelector('.nl-active-head .nl-active-direction.nl-positive svg')).not.toBeNull();
    expect(container.querySelector('.nl-countdown .nl-time-left')?.textContent).toBe('4m 05s');
    expect(container.querySelector('.nl-round-strip b')?.textContent).toBe('4m 05s remaining');
    expect(container.querySelector('.nl-active-round progress')).not.toBeNull();
  });
  it('defaults to 15 minutes; disconnected users cannot enter', () => {
    render();
    expect([...container.querySelectorAll('#round-duration button')].map(b => b.textContent)).toEqual(['5m', '10m', '15m', '30m']);
    expect(container.querySelector('#round-duration [aria-pressed="true"]')?.textContent).toBe('15m');
    expect(container.querySelector('.nl-round-strip b')?.textContent).toBe('15 min');
    expect(container.textContent).not.toMatch(/seconds/i);
    expect((container.querySelector('.nl-up') as HTMLButtonElement).disabled).toBe(true);
    expect(mock.api).not.toHaveBeenCalled();
  });
  it('offers a wallet connection over the idle chart while disconnected, and a trading hint once connected but not enabled', () => {
    render();
    const cta = () => container.querySelector('.nl-chart-area .nl-chart-cta')!;
    expect(cta().getAttribute('data-state')).toBe('connect');
    expect(cta().querySelector('h2')?.textContent).toBe('Call the next 15 min');
    expect(cta().querySelector('.nl-chart-directions')).toBeNull();
    act(() => cta().querySelector<HTMLButtonElement>('.nl-chart-cta-connect')!.click());
    expect(mock.connect).toHaveBeenCalledOnce();
    expect(mock.api).not.toHaveBeenCalled();
    // Connected but trading not enabled yet: no second connect button, just where to finish.
    mock.status = 2; render();
    expect(cta().querySelector('.nl-chart-cta-connect')).toBeNull();
    expect(cta().querySelector('.nl-chart-cta-note')?.textContent).toContain('enabling trading');
  });
  it('puts Up / Down on the idle chart with the stake and length they will use, and starts the round from there', async () => {
    mock.status = 5;
    mock.createKey.mockResolvedValue({ secretKey: 'fake-test-key', key: 'fake-public-key' });
    mock.api.mockResolvedValue({ id: 'round', status: 'opening' });
    render();
    const cta = () => container.querySelector('.nl-chart-area .nl-chart-cta')!;
    expect(cta().getAttribute('data-state')).toBe('play');
    expect(container.querySelector('.nl-pnl-hint')).toBeNull();
    expect(cta().querySelector('.nl-chart-cta-summary')?.textContent).toBe('$5.00 · 15 min');
    // The chart's buttons are copies of the panel's: same classes plus their own, so the panel pair stays the primary.
    expect([...container.querySelectorAll('.nl-up')].map(b => b.className)).toEqual(['nl-up nl-chart-up', 'nl-up']);
    expect([...container.querySelectorAll('.nl-down')].map(b => b.className)).toEqual(['nl-down nl-chart-down', 'nl-down']);
    const input = container.querySelector<HTMLInputElement>('#round-amount')!;
    act(() => { input.value = '7.5'; Simulate.change(input); });
    act(() => container.querySelectorAll<HTMLButtonElement>('#round-duration button')[2].click());
    expect(cta().querySelector('.nl-chart-cta-summary')?.textContent).toBe('$7.50 · 15 min');
    await act(async () => cta().querySelector<HTMLButtonElement>('.nl-chart-down')!.click());
    expect(mock.api).toHaveBeenCalledOnce();
    expect(mock.api.mock.calls[0][1]).toMatchObject({ direction: 'DOWN', duration: 900, margin: 7.5 });
    // Once the round is sending, the chart shows its progress; the call only lingers, inert, while it fades out.
    expect(chart().getAttribute('data-phase')).toBe('sending');
    expect(container.querySelector('.nl-pnl-wait')).not.toBeNull();
    expect(container.querySelector('.nl-chart-cta:not([data-leaving] *)')).toBeNull();
  });
  it('offers the deposit flow instead of dead buttons when the account has nothing to play with', () => {
    mock.status = 5; mock.collateral = 0; render();
    const cta = () => container.querySelector('.nl-chart-area .nl-chart-cta')!;
    expect(cta().getAttribute('data-state')).toBe('deposit');
    expect(cta().querySelector('.nl-chart-directions')).toBeNull();
    act(() => cta().querySelector<HTMLButtonElement>('.nl-chart-cta-deposit')!.click());
    expect(mock.show).toHaveBeenCalledWith('deposit-dialog', { activeTab: 'deposit' });
    // The panel offers the same door, and its own Up / Down stay disabled.
    act(() => container.querySelector<HTMLButtonElement>('.nl-play-panel .nl-panel-deposit')!.click());
    expect(mock.show).toHaveBeenCalledTimes(2);
    expect(container.querySelector<HTMLButtonElement>('.nl-play-panel .nl-up')!.disabled).toBe(true);
    mock.mobile = true; render();
    act(() => cta().querySelector<HTMLButtonElement>('.nl-chart-cta-deposit')!.click());
    expect(mock.show).toHaveBeenLastCalledWith('deposit-sheet', { activeTab: 'deposit' });
    // Funds arrive: the call is back.
    mock.collateral = 20; render();
    expect(cta().getAttribute('data-state')).toBe('play');
    expect(container.querySelector('.nl-panel-deposit')).toBeNull();
  });
  it('never shows the market, price, 24h stats or leverage: one toolbar line with the record and the LIVE dot', () => {
    mock.status = 5; render();
    expect(container.querySelector('[aria-label="Select market"]')).toBeNull();
    expect(container.querySelector('.nl-market-picker')).toBeNull();
    expect(container.querySelector('.nl-market-header')).toBeNull();
    expect(container.querySelector('.nl-market-price')).toBeNull();
    expect(container.querySelector('.nl-coin')).toBeNull();
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('#round-leverage')).toBeNull();
    // The only slider is the stake over the balance; leverage is never a control.
    expect([...container.querySelectorAll('input[type="range"]')].map(i => i.getAttribute('aria-label'))).toEqual(['Stake amount']);
    const text = () => container.textContent!;
    expect(text()).not.toMatch(/BTC|SOL|bitcoin|perpetual|\$100\.0000|24h|volume|\d+×|leverage|price/i);
    expect(container.querySelector('.nl-luck-header')).toBeNull();
    expect(text()).not.toContain('Feeling lucky');
    expect(text()).not.toContain('Nothing to study');
    const header = container.querySelector('.nl-chart-toolbar')!;
    expect(header.querySelector('.nl-streak')).toBeNull();
    expect(header.querySelector('.nl-live')?.textContent).toBe(' LIVE');
    mock.ws = 'disconnected'; render();
    expect(header.querySelector('.nl-live')?.textContent).toBe(' RECONNECTING');
    expect(container.querySelector('.nl-chart-toolbar')?.textContent).toBe('Round resultYour record — RECONNECTING');
    // The streak badge and record only count reconciled results; an open round and a failed one count for nothing.
    const win = (id: string, pnl: number) => ({ id, status: 'closed', symbol: GAME_SYMBOL, direction: 'UP', duration: 300, leverage: 100, margin: 5, quantity: .05, tradingPnl: pnl });
    mock.rows = [{ ...win('open', 0), status: 'open', entryPrice: 100, deadline: Date.now() + 30000 }, win('a', .4), win('b', .2), { ...win('x', 0), status: 'failed', tradingPnl: undefined }, win('c', .9), win('d', -.3), win('e', .1)];
    mock.ws = 'connected'; render();
    expect(header.querySelector('.nl-streak')?.textContent).toBe('🔥 2 in a row');
    expect(container.querySelector('.nl-chart-toolbar b')?.textContent).toBe('4W · 1L');
    mock.rows = [win('a', .4), win('b', -.2)]; render();
    expect(header.querySelector('.nl-streak')).toBeNull();
    expect(container.querySelector('.nl-chart-toolbar b')?.textContent).toBe('1W · 1L');
    expect(text()).not.toMatch(/BTC|\d+×|leverage/i);
  });
  it('executes Up directly with the selected amount and duration on the BTC market at maximum leverage', async () => {
    mock.status = 5;
    mock.createKey.mockResolvedValue({ secretKey: 'fake-test-key', key: 'fake-public-key' });
    mock.api.mockResolvedValue({ id: 'round', status: 'opening' });
    render();
    act(() => container.querySelectorAll<HTMLButtonElement>('#round-duration button')[1].click());
    await act(async () => container.querySelector<HTMLButtonElement>('.nl-up')!.click());
    expect(mock.api).toHaveBeenCalledOnce();
    expect(mock.api.mock.calls[0][0]).toBe('/rounds');
    expect(mock.api.mock.calls[0][1]).toMatchObject({ symbol: 'PERP_BTC_USDC', direction: 'UP', duration: 600, leverage: 100, margin: 5, authorize: true });
    expect(container.querySelector('.nl-round-strip b')?.textContent).toBe('10 min');
    expect(container.querySelector('[aria-label="Close confirmation"]')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });
  it('locks the entry controls during an active round', () => {
    mock.status = 5;
    mock.rows = [{ id: 'round', accountId: 'test', status: 'open', symbol: GAME_SYMBOL, direction: 'UP', duration: 30, leverage: 50, margin: 1, quantity: .5, deadline: Date.now() + 30000, entryPrice: 100 }];
    render();
    expect(container.querySelector('.nl-up')).toBeNull();
    expect(container.querySelector('#round-amount')).toBeNull();
    expect(container.textContent).toContain('Close round early');
  });
  it('shows only the net live result, never a gross gain as profit', () => {
    mock.status = 5; mock.price = 110.141;
    mock.rows = [{ id: 'round', status: 'open', symbol: GAME_SYMBOL, direction: 'UP', duration: 30, leverage: 100, margin: 1, quantity: .9, entryPrice: 110.118, openFee: .029732 }];
    render();
    const panel = () => container.querySelector('[aria-label="Live result"]')!;
    expect(panel().textContent).toContain('-$0.0388');
    expect(panel().textContent).toContain('Your result');
    expect(panel().textContent).toContain('Estimated · fees included');
    expect(panel().textContent).not.toContain('$0.0207');
    expect(panel().querySelector('strong')?.className).toBe('nl-negative');
    expect(panel().querySelector('dl')).toBeNull();
    mock.price = 111; render();
    expect(panel().textContent).toContain('$0.7341');
    expect(panel().querySelector('strong')?.className).toBe('nl-positive');
    mock.ws = 'disconnected'; render();
    expect(panel().textContent).toContain('Price stream reconnecting');
    expect(panel().textContent).not.toContain('$0.7341');
  });
  it('keeps the game screen free of FAQ, explainer and service copy', () => {
    mock.status = 5; render();
    const text = container.textContent;
    for (const removed of ['Good to know', 'Pick. Call.', 'market decides', 'Local round service', 'Keep it running', 'Round service offline']) expect(text).not.toContain(removed);
    expect(container.querySelector('#round-faq')).toBeNull();
    expect(container.querySelector('.nl-play-panel')?.textContent).not.toMatch(/Est\. entry \+ exit fees|Position exposure|Fees as %|Price move to cover fees/);
    mock.rows = [{ id: 'round', status: 'open', symbol: GAME_SYMBOL, direction: 'UP', duration: 30, leverage: 100, margin: 1, quantity: 1, entryPrice: 100, deadline: Date.now() + 30000 }];
    render();
    expect(container.textContent).not.toContain('Keep it running');
    expect(container.textContent).not.toContain('Local round service');
  });
  it('explains disabled directions with one line when the round service is offline', () => {
    mock.status = 5; mock.health = { ready: false, network: 'testnet' }; render();
    expect(container.querySelector('.nl-service-offline')?.textContent).toBe('Round service offline.');
    expect(container.querySelector<HTMLButtonElement>('.nl-up')!.disabled).toBe(true);
    mock.health = undefined; mock.healthError = 'Connection lost.'; render();
    expect(container.textContent).toContain('Round service offline.');
    expect(container.querySelector<HTMLButtonElement>('.nl-down')!.disabled).toBe(true);
    mock.health = { ready: true, network: 'testnet' }; mock.healthError = ''; render();
    expect(container.textContent).not.toContain('Round service offline');
    expect(container.querySelector<HTMLButtonElement>('.nl-up')!.disabled).toBe(false);
  });
  it('starts below zero and withholds the result while closing fills reconcile', () => {
    mock.status = 5; mock.price = 100;
    mock.rows = [{ id: 'round', status: 'open', symbol: GAME_SYMBOL, direction: 'DOWN', duration: 30, leverage: 100, margin: 1, quantity: 1, entryPrice: 100, openFee: .03 }];
    render();
    const panel = () => container.querySelector('[aria-label="Live result"]')!;
    expect(panel().textContent).toContain('-$0.0600');
    mock.rows[0].positionQuantity = 0;
    render();
    expect(panel().textContent).toContain('Reconciling position fills');
    expect(panel().textContent).not.toContain('-$0.0600');
    expect(panel().querySelector('strong')?.className).toBe('');
  });
  it('shows the finished round as a single net result line', () => {
    mock.rows = [{ id: 'round', status: 'closed', symbol: 'PERP_SOL_USDC', direction: 'UP', duration: 30, leverage: 100, margin: 1, quantity: .9, entryPrice: 110.118, exitPrice: 110.141, fees: .059471, tradingPnl: -.038771 }];
    render();
    const strip = () => container.querySelector('.nl-last-strip')!;
    expect(strip().textContent).toBe('Last round · Called · -$0.04');
    expect(strip().querySelector('.nl-coin')).toBeNull();
    expect(strip().querySelector('[aria-label="Up"]')).not.toBeNull();
    expect(strip().querySelectorAll('b')[1].className).toBe('nl-negative');
    mock.rows = [{ ...mock.rows[0], tradingPnl: .82 }]; render();
    expect(strip().textContent).toBe('Last round · Called · +$0.82');
    expect(strip().querySelectorAll('b')[1].className).toBe('nl-positive');
    // Unreconciled results are never invented.
    mock.rows = [{ ...mock.rows[0], status: 'failed', tradingPnl: undefined }]; render();
    expect(strip().textContent).toBe('Last round · Called · failed');
  });
  it('executes each direction through the shared device authorization manager', async () => {
    mock.status = 5;
    mock.createKey.mockResolvedValue({ secretKey: 'fake-test-key', key: 'fake-public-key' });
    mock.api.mockResolvedValue({ id: 'round', status: 'opening' });
    render();
    await act(async () => container.querySelector<HTMLButtonElement>('.nl-down')!.click());
    expect(mock.api.mock.calls[0][1]).toMatchObject({ symbol: GAME_SYMBOL, direction: 'DOWN', duration: 900, leverage: 100, margin: 5, authorize: true });
    mock.rows = [{ id: mock.api.mock.calls[0][1].id, status: 'closed', symbol: GAME_SYMBOL, direction: 'DOWN', duration: 30, margin: 5, leverage: 100, createdAt: Date.now() }]; render();
    await act(async () => container.querySelector<HTMLButtonElement>('.nl-up')!.click());
    expect(mock.createKey).toHaveBeenCalledTimes(2);
    expect(mock.api).toHaveBeenCalledTimes(2);
    expect(mock.api.mock.calls[1][1].direction).toBe('UP');
    expect(mock.api.mock.calls[1][1].id).not.toBe(mock.api.mock.calls[0][1].id);
  });
  it('ignores rapid repeated direction clicks while authorizing', async () => {
    mock.status = 5;
    let finish!: (key: any) => void;
    mock.createKey.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mock.api.mockResolvedValue({ id: 'round', status: 'opening' });
    render();
    act(() => {
      container.querySelector<HTMLButtonElement>('.nl-down')!.click();
      container.querySelector<HTMLButtonElement>('.nl-up')!.click();
    });
    expect(mock.createKey).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLButtonElement>('.nl-up')!.disabled).toBe(true);
    await act(async () => finish({ secretKey: 'test-key' }));
    expect(mock.api).toHaveBeenCalledOnce();
    expect(mock.api.mock.calls[0][1].direction).toBe('DOWN');
  });
  it('does not submit when the account disconnects during wallet authorization', async () => {
    mock.status = 5;
    let finish!: (key: any) => void;
    mock.createKey.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render();
    act(() => container.querySelector<HTMLButtonElement>('.nl-up')!.click());
    mock.status = 0; render();
    await act(async () => finish({ secretKey: 'test-key' }));
    expect(mock.api).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Your account changed during authorization');
  });
  it('shares affordability between the slider, share chips, manual entry, Max and the direction buttons', () => {
    mock.status = 5; mock.collateral = 9.36; render();
    const input = container.querySelector<HTMLInputElement>('#round-amount')!;
    const slider = container.querySelector<HTMLInputElement>('.nl-stake-slider input')!;
    const up = () => container.querySelector<HTMLButtonElement>('.nl-play-panel .nl-up')!;
    expect(input.value).toBe('5');
    expect(slider.max).toBe('8.46');
    expect(slider.value).toBe('5');
    expect(container.querySelector('.nl-available')?.textContent).toContain('of $8.46 available');
    const chips = [...container.querySelectorAll<HTMLButtonElement>('.nl-amount-presets button')];
    expect(chips.map(button => button.textContent)).toEqual(['10%', '25%', '50%', '75%', 'All']);
    expect(chips.map(button => button.disabled)).toEqual([false, false, false, false, false]);
    act(() => { input.value = '10'; Simulate.change(input); });
    expect(up().disabled).toBe(true);
    expect(container.textContent).toContain('This amount is above your available balance');
    expect(slider.value).toBe('8.46');
    act(() => chips[1].click());
    expect(input.value).toBe('2.11');
    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
    expect(up().disabled).toBe(false);
    act(() => { slider.value = '6.2'; Simulate.change(slider); });
    expect(input.value).toBe('6.20');
    expect(chips.every(chip => chip.getAttribute('aria-pressed') === 'false')).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>('.nl-amount-max')!.click());
    expect(input.value).toBe('8.46');
    expect(chips[4].getAttribute('aria-pressed')).toBe('true');
    expect(up().disabled).toBe(false);
    expect(container.textContent).not.toContain('This amount is above your available balance');
    // A balance refresh invalidates an amount immediately; Max and the slider follow the new budget.
    mock.collateral = 5; render();
    expect(up().disabled).toBe(true);
    expect(slider.max).toBe('4.52');
    act(() => container.querySelector<HTMLButtonElement>('.nl-amount-max')!.click());
    expect(input.value).toBe('4.52');
    expect(up().disabled).toBe(false);
    // Under the market minimum the call is off and the reason is spelled out.
    act(() => { input.value = '0.05'; Simulate.change(input); });
    expect(up().disabled).toBe(true);
    expect(container.querySelector('.nl-field-error')?.textContent).toBe('Stakes start at $0.10. Move the slider up a little.');
  });

  it('keeps the play screen copy luck-focused: no isolated/margin/market wording, UP / DOWN calls', () => {
    mock.status = 5; render();
    expect(container.querySelector('h1')?.textContent).toBe('Up or down?');
    expect(container.querySelector('h1 em')?.textContent).toBe('down');
    expect(container.querySelector('.nl-page-heading p')?.textContent).toBe("Call it. Watch the clock. Win or lose on Cato's luck.");
    expect(container.querySelector('.nl-page-heading .nl-eyebrow')).toBeNull();
    expect(container.querySelector('.nl-card-heading')?.textContent).toBe('YOUR CALL');
    expect(container.querySelector('label[for="round-amount"]')?.textContent).toBe('Your stake');
    expect(container.querySelector('label[for="round-duration"]')?.textContent).toBe('Round length');
    expect(container.querySelector('.nl-amount-input b')?.textContent).toBe('USDC');
    expect(container.querySelector('.nl-pill')).toBeNull();
    expect(container.querySelector('.nl-up')?.textContent).toBe('UP ▲');
    expect(container.querySelector('.nl-down')?.textContent).toBe('DOWN ▼');
    const text = container.textContent!;
    for (const removed of ['ISOLATED', 'Price goes', 'Make your next', 'A LITTLE INSTINCT', 'Trust your call', 'Know your risk', 'YOUR NEXT ROUND', 'Round amount', 'Pick a coin', 'Bitcoin', 'BTC', 'Your bet', 'Duration']) expect(text).not.toContain(removed);
    expect(text).not.toMatch(/isolated|cross margin|margin|leverage|\d+×|\bmax\b/i);
    mock.rows = [{ id: 'round', status: 'open', symbol: GAME_SYMBOL, direction: 'UP', duration: 300, leverage: 100, margin: 1, quantity: 1, entryPrice: 100, deadline: Date.now() + 30000 }];
    render();
    expect(container.textContent).not.toMatch(/isolated|margin|leverage|\d+×|BTC/i);
    expect(container.querySelector('.nl-details')?.textContent).toBe('Your stake$1.00');
  });
  it('keeps the last-round strip as the panel footer, also during an active round', () => {
    mock.status = 5; render();
    expect(container.querySelector('.nl-play-panel > .nl-last-strip')?.textContent).toBe('No rounds yet. Your first call shows here.');
    const finished = { id: 'old', status: 'closed', symbol: GAME_SYMBOL, direction: 'UP', duration: 300, leverage: 100, margin: 1, quantity: 1, tradingPnl: .82, closedAt: Date.now() - 5000 };
    mock.rows = [{ id: 'round', status: 'open', symbol: GAME_SYMBOL, direction: 'DOWN', duration: 300, leverage: 50, margin: 1, quantity: 1, entryPrice: 100, deadline: Date.now() + 30000 }, finished];
    render();
    expect(container.querySelector('.nl-active-round')).not.toBeNull();
    const strip = container.querySelector('.nl-play-panel > .nl-last-strip');
    expect(strip?.textContent).toBe('Last round · Called · +$0.82');
    expect(strip?.previousElementSibling?.className).toBe('nl-play-body');
  });
  it('ends both panels with a shared footer so their edges line up', () => {
    mock.status = 5; render();
    const footers = [...container.querySelectorAll('.nl-panel-footer')];
    expect(footers.map(f => [f.tagName, f.parentElement?.className, f.classList.contains('nl-round-strip') || f.classList.contains('nl-last-strip')]))
      .toEqual([['FOOTER', 'nl-market-panel', true], ['FOOTER', 'nl-play-panel', true]]);
    // Each footer is its panel's last child, so it is pinned to the panel bottom.
    for (const footer of footers) expect(footer.nextElementSibling).toBeNull();
    expect(footers[0].textContent).toBe('Every round starts with a call15 min');
  });
  it('houses the cat in its own side panel, above the controls, with a pose that follows the round', () => {
    const room = () => container.querySelector<HTMLElement>('.nl-cat-panel .nl-cat-room')!;
    const img = () => room().querySelector<HTMLImageElement>('img.nl-cat-room-img')!;
    render();
    // jsdom has no WebGL, so the panel shows the static pose image.
    expect(room().getAttribute('data-mode')).toBe('static');
    expect(room().getAttribute('aria-hidden')).toBe('true');
    expect(img().getAttribute('src')).toBe('/updown/cato/asleep.webp');
    expect(img().getAttribute('alt')).toBe('');
    const panel = container.querySelector('.nl-side-column > .nl-cat-panel')!;
    expect(panel.nextElementSibling?.className).toBe('nl-play-panel');
    expect(container.querySelectorAll('.nl-cat-room')).toHaveLength(1);
    expect(container.querySelector('.nl-market-panel .nl-cat-room')).toBeNull();
    mock.status = 5; render();
    expect(room().getAttribute('data-pose')).toBe('wave');
    mock.rows = [{ id: 'round', status: 'open', symbol: GAME_SYMBOL, direction: 'UP', duration: 300, leverage: 100, margin: 1, quantity: 1, entryPrice: 100, openFee: .03, deadline: Date.now() + 30000 }];
    mock.price = 101; render();
    expect(room().getAttribute('data-pose')).toBe('alert');
    mock.price = 99; render();
    expect(room().getAttribute('data-pose')).toBe('confused');
  });
  it('shows the authorization rejection and does not submit an order', async () => {
    mock.status = 5;
    mock.createKey.mockRejectedValue(new Error('Orderly rejected round authorization (code -1): Key limit reached. No round was submitted.'));
    render();
    await act(async () => container.querySelector<HTMLButtonElement>('.nl-up')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Key limit reached');
    expect(mock.api).not.toHaveBeenCalled();
    expect(chart().getAttribute('data-phase')).toBe('idle');
  });
});

describe('result chart phases', () => {
  it('is idle with the call to action until a direction is chosen', () => {
    mock.status = 5; render();
    expect(chart().getAttribute('data-phase')).toBe('idle');
    expect(chart().querySelector('.nl-pnl-plot .nl-chart-cta .nl-chart-directions')).not.toBeNull();
    expect(chart().textContent).not.toContain('Pick Up or Down to play');
  });
  it('sends from the click until the round reports a real fill, then charts the net result each second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(500000);
    mock.status = 5; mock.price = 100;
    let finish!: (key: any) => void;
    mock.createKey.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    mock.api.mockResolvedValue({ id: 'round', status: 'opening' });
    render();
    act(() => container.querySelector<HTMLButtonElement>('.nl-up')!.click());
    expect(chart().getAttribute('data-phase')).toBe('sending');
    expect(chart().querySelector('.nl-pnl-steps li.active')?.textContent).toBe('Placing your call…');
    await act(async () => finish({ secretKey: 'test-key' }));
    expect(chart().getAttribute('data-phase')).toBe('sending');
    const id = mock.api.mock.calls[0][1].id as string;
    // The service knows the round but has no fill yet: still sending, never "open".
    mock.rows = [{ id, status: 'opening', symbol: GAME_SYMBOL, direction: 'UP', duration: 300, leverage: 100, margin: 5, quantity: .05, createdAt: 500000 }];
    render();
    expect(chart().getAttribute('data-phase')).toBe('sending');
    expect(chart().querySelector('.nl-pnl-value')).toBeNull();
    act(() => { vi.advanceTimersByTime(11000); });
    mock.rows = [{ ...mock.rows[0] }]; render();
    // The quote rests at the best price for up to 20s before the service finishes the fill with a market order.
    expect(chart().querySelector('.nl-pnl-steps li.active')?.textContent).toBe('Waiting for a fill at the best price…');
    expect(chart().querySelector('.nl-pnl-fill-progress')).toBeNull();
    expect(chart().querySelector('.nl-pnl-cancel')?.textContent).toBe('Cancel');
    expect(container.querySelector('.nl-active-round')).not.toBeNull();
    expect(container.querySelector('.nl-cancel-opening')?.textContent).toBe('Cancel call');
    // A partial fill shows as progress on the chart and under the timer.
    mock.rows = [{ ...mock.rows[0], fill: { filledQuantity: .02, quantity: .05, quotes: 2, maker: true, fallback: false } }]; render();
    expect(chart().querySelector('.nl-pnl-fill-progress')?.textContent).toBe('Filled 40%');
    expect(container.querySelector('.nl-countdown-meta')?.textContent).toBe('OPENING · FILLED 40%');
    act(() => { vi.advanceTimersByTime(9000); });
    mock.rows = [{ ...mock.rows[0] }]; render();
    expect(chart().querySelector('.nl-pnl-stalled')?.textContent).toBe('Finishing the fill…');
    expect(chart().querySelector('.nl-pnl-cancel')).not.toBeNull();
    // The fill arrives: the chart opens on the real entry and pins the live net result and countdown.
    mock.rows = [{ ...mock.rows[0], status: 'open', entryPrice: 100, openFee: .0015, openedAt: 520000, deadline: 820000 }];
    mock.price = 101; render();
    expect(chart().getAttribute('data-phase')).toBe('open');
    expect(chart().querySelector('.nl-pnl-cancel')).toBeNull();
    expect(container.querySelector('.nl-cancel-opening')).toBeNull();
    // (101 - 100) * .05 = .05 gross - .0015 open fee - 101 * .05 * .0003 exit fee
    expect(chart().querySelector('.nl-pnl-value')?.textContent).toBe('+$0.05');
    expect(chart().querySelector('.nl-pnl-countdown')?.textContent).toBe('5m 00s');
    expect(chart().querySelectorAll('.nl-pnl-line')).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1000); });
    mock.price = 99; render();
    expect(chart().querySelector('.nl-pnl-value')?.textContent).toBe('-$0.05');
    expect(chart().querySelector('.nl-pnl-value')?.className).toContain('nl-negative');
    expect(chart().querySelector('.nl-pnl-line')?.getAttribute('d')).toMatch(/^M 0\.00 .* C .* 2\.00 [\d.]+$/);
    // Toggle to percent of the bet.
    act(() => [...chart().querySelectorAll<HTMLButtonElement>('.nl-pnl-units button')].find(b => b.textContent === '%')!.click());
    expect(chart().querySelector('.nl-pnl-value')?.textContent).toBe('-1.06%');
    expect(localStorage.getItem('updown.pnl-unit')).toBe('%');
  });
  it('cancels an opening round through the cancel route, from the chart link or the panel button', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(600000);
    mock.status = 5;
    const id = 'round-cancel';
    const opening = { id, accountId: '0x' + 'a'.repeat(64), status: 'opening', symbol: GAME_SYMBOL, direction: 'UP', duration: 300, leverage: 100, margin: 5, quantity: .05, createdAt: 599000, fill: { filledQuantity: 0, quantity: .05, quotes: 1, maker: true, fallback: false } };
    mock.rows = [opening];
    mock.api.mockResolvedValue({ ...mock.rows[0], openCancelRequested: true });
    render();
    expect(chart().getAttribute('data-phase')).toBe('sending');
    await act(async () => chart().querySelector<HTMLButtonElement>('.nl-pnl-cancel')!.click());
    expect(mock.api).toHaveBeenCalledWith('/rounds/round-cancel/cancel', {});
    expect(mock.api).toHaveBeenCalledOnce();
    // Once the service has the request on record, neither control offers it again.
    mock.rows = [{ ...mock.rows[0], openCancelRequested: true }]; render();
    expect(chart().querySelector('.nl-pnl-cancel')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.nl-cancel-opening')?.disabled).toBe(true);
    expect(container.querySelector('.nl-cancel-opening')?.textContent).toBe('Cancelling…');
    // Nothing filled: the round failed and the table is free again.
    mock.rows = [{ ...mock.rows[0], status: 'failed', error: 'Cancelled before fill' }]; render();
    expect(chart().getAttribute('data-phase')).toBe('idle');
    expect(container.querySelector('.nl-up')).not.toBeNull();
    // A partial fill that was closed: ended early with a confirmed result, shown as final.
    mock.rows = [{ ...mock.rows[0], status: 'ended_early', closeReason: 'cancelled', resultPending: false, cancelledOpening: true, quantity: .02, entryPrice: 100, exitPrice: 100.5, fees: .01, tradingPnl: 0, closedAt: 599500 }]; render();
    expect(chart().getAttribute('data-phase')).toBe('closed');
    expect(chart().querySelector('.nl-pnl-final')?.textContent).toBe('Final');
    expect(container.querySelector('.nl-last-strip')?.textContent).not.toContain('Confirming result');
    // The panel button reaches the same route.
    mock.rows = [{ ...opening }]; mock.api.mockClear(); render();
    await act(async () => container.querySelector<HTMLButtonElement>('.nl-cancel-opening')!.click());
    expect(mock.api).toHaveBeenCalledWith('/rounds/round-cancel/cancel', {});
  });
  it('freezes the line with the final result once the round closes, until the next round starts', () => {
    vi.spyOn(Date, 'now').mockReturnValue(600000);
    mock.status = 5;
    recordPnl('done', { time: 590000, net: .1, percent: 2 });
    recordPnl('done', { time: 591000, net: .3, percent: 6 });
    mock.rows = [{ id: 'done', accountId: '0x' + 'a'.repeat(64), status: 'closed', symbol: GAME_SYMBOL, direction: 'UP', duration: 300, leverage: 100, margin: 5, quantity: .05, entryPrice: 100, exitPrice: 101, tradingPnl: .28, fees: .03, closedAt: 595000 }];
    render();
    expect(chart().getAttribute('data-phase')).toBe('closed');
    expect(chart().querySelector('.nl-pnl-value')?.textContent).toBe('+$0.28');
    expect(chart().querySelector('.nl-pnl-value')?.className).toContain('nl-positive');
    expect(chart().querySelector('.nl-pnl-final')?.textContent).toBe('Final');
    expect(chart().querySelector('.nl-pnl-line')?.getAttribute('d')).toMatch(/^M 0\.00 .* C .* 10\.00 [\d.]+$/);
    expect(container.querySelector('.nl-up')).not.toBeNull();
    // A loss closes red; an unreconciled early end pins no number.
    mock.rows = [{ ...mock.rows[0], tradingPnl: -.5 }]; render();
    expect(chart().querySelector('.nl-pnl-value')?.className).toContain('nl-negative');
    mock.rows = [{ ...mock.rows[0], status: 'ended_early', tradingPnl: undefined }]; render();
    expect(chart().querySelector('.nl-pnl-value')?.textContent).toBe('Confirming result…');
    // Long-finished rounds without a line in memory are not replayed.
    clearSeries();
    mock.rows = [{ ...mock.rows[0], status: 'closed', tradingPnl: .28, closedAt: 600000 - 11 * 60000 }]; render();
    expect(chart().getAttribute('data-phase')).toBe('idle');
  });
});

describe('catPose', () => {
  const now = 1_000_000;
  it('sleeps while disconnected, whatever the rounds say', () => {
    expect(catPose({ connected: false, active: false, now })).toBe('asleep');
    expect(catPose({ connected: false, active: true, liveResult: 5, now })).toBe('asleep');
  });
  it('waves when connected and idle', () => {
    expect(catPose({ connected: true, active: false, now })).toBe('wave');
  });
  it('watches a round at or above zero and is confused below zero', () => {
    expect(catPose({ connected: true, active: true, liveResult: 0, now })).toBe('alert');
    expect(catPose({ connected: true, active: true, liveResult: .5, now })).toBe('alert');
    expect(catPose({ connected: true, active: true, now })).toBe('alert');
    expect(catPose({ connected: true, active: true, liveResult: -.01, now })).toBe('confused');
    // An active round wins over the previous round's result.
    expect(catPose({ connected: true, active: true, liveResult: 1, last: { tradingPnl: -3, closedAt: now - 1000 }, now })).toBe('alert');
  });
  it('celebrates a fresh win, is confused by a fresh loss, then goes back to waving', () => {
    expect(catPose({ connected: true, active: false, last: { tradingPnl: .82, closedAt: now - 1000 }, now })).toBe('celebrate');
    expect(catPose({ connected: true, active: false, last: { tradingPnl: -.04, closedAt: now - 1000 }, now })).toBe('confused');
    expect(catPose({ connected: true, active: false, last: { tradingPnl: .82, closedAt: now - CAT_REACTION_MS }, now })).toBe('celebrate');
    expect(catPose({ connected: true, active: false, last: { tradingPnl: .82, closedAt: now - CAT_REACTION_MS - 1 }, now })).toBe('wave');
    expect(catPose({ connected: true, active: false, last: { tradingPnl: -.04, closedAt: now - CAT_REACTION_MS - 1 }, now })).toBe('wave');
  });
  it('never reacts to a result that is not reconciled or has no close time', () => {
    expect(catPose({ connected: true, active: false, last: { closedAt: now - 1000 }, now })).toBe('wave');
    expect(catPose({ connected: true, active: false, last: { tradingPnl: 0, closedAt: now - 1000 }, now })).toBe('wave');
    expect(catPose({ connected: true, active: false, last: { tradingPnl: 2 }, now })).toBe('wave');
  });
});
