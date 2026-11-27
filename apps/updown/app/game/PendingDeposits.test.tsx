import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dollars } from './api';
import { PENDING_HISTORY_KEY, PENDING_POLL_MS, PendingDeposits, recentTransfers, usePendingTransfers } from './PendingDeposits';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const mock = vi.hoisted(() => ({
  data: undefined as unknown,
  query: vi.fn(),
  mutate: vi.fn(),
  listeners: new Map<string, () => void>(),
}));
vi.mock('@orderly.network/hooks', () => ({
  usePrivateQuery: (key: string | null, options: unknown) => { mock.query(key, options); return { data: key ? mock.data : undefined, mutate: mock.mutate }; },
  useEventEmitter: () => mockEmitter,
}));
const mockEmitter = { on: (e: string, fn: () => void) => mock.listeners.set(e, fn), off: (e: string) => mock.listeners.delete(e) };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1', tx_id: '0xabc', side: 'DEPOSIT', token: 'USDC', amount: 25, fee: 0,
  trans_status: 'PENDING', created_time: NOW - 15_000, updated_time: NOW - 15_000, chain_id: '42161', ...over,
});

function Harness({ ready = true, accountId = 'acc' }: { ready?: boolean; accountId?: string }) {
  const t = usePendingTransfers({ ready, accountId });
  return <div data-pending={String(t.pending)}><PendingDeposits items={t.items} now={t.now} onDismiss={t.dismiss}/></div>;
}

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: NOW });
  mock.data = undefined; mock.query.mockClear(); mock.mutate.mockClear(); mock.listeners.clear();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

const render = (el = <Harness/>) => act(() => root.render(el));
const tick = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const strip = () => container.querySelector('.nl-pending-strip');
const lastInterval = () => (mock.query.mock.calls.at(-1)?.[1] as { refreshInterval: number }).refreshInterval;

describe('PendingDeposits', () => {
  it('renders nothing while loading, when empty, or when the account is not ready', () => {
    render();
    expect(strip()).toBeNull();
    mock.data = [];
    render();
    expect(container.querySelector('.nl-pending-strip')).toBeNull();
    expect(lastInterval()).toBe(0);
    mock.data = [row()];
    render(<Harness ready={false}/>);
    expect(strip()).toBeNull();
    expect(mock.query).toHaveBeenLastCalledWith(null, expect.anything());
  });

  it('shows a pending deposit with a countdown and polls every 5s', () => {
    mock.data = [row()];
    render();
    expect(strip()?.textContent).toContain(`Deposit of ${dollars(25)} on its way`);
    expect(strip()?.textContent).toContain('about 45s left');
    expect(container.firstElementChild?.getAttribute('data-pending')).toBe('true');
    expect(mock.query).toHaveBeenLastCalledWith(PENDING_HISTORY_KEY, expect.objectContaining({ refreshInterval: PENDING_POLL_MS }));
    tick(10_000);
    expect(strip()?.textContent).toContain('about 35s left');
  });

  it('says "taking a little longer" after 60s and keeps showing until settled', () => {
    mock.data = [row()];
    render();
    tick(46_000);
    expect(strip()?.textContent).toContain('taking a little longer than usual…');
    expect(strip()?.textContent).not.toMatch(/s left/);
    tick(120_000);
    expect(strip()?.textContent).toContain('on its way');
  });

  it('flips to "landed" on completion, then hides after 8s and stops polling', () => {
    mock.data = [row()];
    render();
    mock.data = [row({ trans_status: 'COMPLETED' })];
    render();
    expect(strip()?.textContent).toBe(`Deposit of ${dollars(25)} landed`);
    expect(strip()?.querySelector('.nl-pending-landed')).not.toBeNull();
    expect(container.firstElementChild?.getAttribute('data-pending')).toBe('false');
    expect(lastInterval()).toBe(0);
    tick(7_000);
    expect(strip()).not.toBeNull();
    tick(1_500);
    expect(strip()).toBeNull();
  });

  it('shows the failure strip until dismissed', () => {
    mock.data = [row({ side: 'WITHDRAW', amount: -25 })];
    render();
    expect(strip()?.textContent).toContain(`Withdrawal of ${dollars(25)} on its way`);
    mock.data = [row({ side: 'DEPOSIT', trans_status: 'FAILED' })];
    render();
    expect(strip()?.textContent).toBe('Deposit failed. Nothing was taken.');
    tick(60_000);
    const dismiss = container.querySelector<HTMLButtonElement>('.nl-pending-dismiss')!;
    expect(dismiss).not.toBeNull();
    act(() => Simulate.click(dismiss));
    expect(strip()).toBeNull();
  });

  it('does not announce completions that happened before the page loaded', () => {
    mock.data = [row({ trans_status: 'COMPLETED' }), row({ id: 'd2', tx_id: '0xdef', trans_status: 'FAILED' })];
    render();
    expect(strip()).toBeNull();
  });

  it('announces a transfer created after load even if first seen completed', () => {
    mock.data = [];
    render();
    tick(1_000);
    mock.data = [row({ created_time: NOW + 500, trans_status: 'COMPLETED' })];
    render();
    expect(strip()?.textContent).toContain('landed');
  });

  it('lists each pending transfer, ignoring rows older than 24h and duplicate tx hashes', () => {
    mock.data = [
      row(),
      row({ id: 'd1-dup' }),
      row({ id: 'w1', tx_id: '0x999', side: 'WITHDRAW', amount: 10, fee: 1, created_time: NOW - 5_000 }),
      row({ id: 'old', tx_id: '0xold', created_time: NOW - 25 * 3600_000 }),
    ];
    render();
    const lines = [...container.querySelectorAll('.nl-pending-line')].map(l => l.querySelector('.nl-pending-text')?.textContent);
    expect(lines).toEqual([`Withdrawal of ${dollars(9)} on its way`, `Deposit of ${dollars(25)} on its way`]);
  });

  it('refetches when the SDK pushes a wallet change', () => {
    mock.data = [];
    render();
    act(() => mock.listeners.get('wallet:changed')?.());
    expect(mock.mutate).toHaveBeenCalled();
  });

  it('recentTransfers keeps deposits/withdrawals only', () => {
    expect(recentTransfers([row({ side: 'TRANSFER' }) as any], NOW)).toEqual([]);
  });
});
