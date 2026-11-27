import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BalanceBar } from './BalanceBar';

const mock = vi.hoisted(() => ({ status: 5, show: vi.fn(), history: undefined as unknown, query: vi.fn() }));
vi.mock('@orderly.network/hooks', () => ({
  useAccount: () => ({ state: { status: mock.status, accountId: 'acc' } }),
  useCollateral: () => ({ totalValue: 120, availableBalance: 90, usdcHolding: 100 }),
  usePrivateQuery: (key: string | null, options: unknown) => { mock.query(key, options); return { data: key ? mock.history : undefined, mutate: vi.fn() }; },
  useEventEmitter: () => ({ on: vi.fn(), off: vi.fn() }),
}));
vi.mock('@orderly.network/ui', () => ({ modal: { show: (...a: unknown[]) => mock.show(...a) }, useScreen: () => ({ isMobile: false }) }));
vi.mock('@orderly.network/ui-transfer', () => ({ DepositAndWithdrawWithDialogId: 'dialog', DepositAndWithdrawWithSheetId: 'sheet' }));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mock.status = 5; mock.history = undefined; mock.query.mockClear();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (el: JSX.Element) => act(() => root.render(<MemoryRouter>{el}</MemoryRouter>));
const actions = () => [...container.querySelectorAll('.nl-funding-actions > *')];

describe('BalanceBar', () => {
  it('defaults to Deposit, Withdraw and a Portfolio button (play screen)', () => {
    render(<BalanceBar/>);
    expect(actions().map(el => [el.tagName, el.className, el.textContent])).toEqual([
      ['BUTTON', 'nl-button nl-button-amber', 'Deposit'],
      ['BUTTON', 'nl-button', 'Withdraw'],
      ['A', 'nl-button', 'Portfolio'],
    ]);
    const link = actions()[2];
    expect(link.getAttribute('href')).toBe('/portfolio');
    expect(link.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('.nl-text-link')).toBeNull();
  });

  it('links back to the game from the portfolio page', () => {
    render(<BalanceBar destination="play"/>);
    const link = actions()[2];
    expect([link.tagName, link.className, link.textContent, link.getAttribute('href')]).toEqual(['A', 'nl-button', 'Play', '/']);
    expect(link.querySelector('svg')).not.toBeNull();
    expect(container.textContent).not.toContain('Portfolio');
  });

  it('opens the transfer dialog and stays navigable while trading is disabled', () => {
    render(<BalanceBar/>);
    act(() => Simulate.click(actions()[0]));
    expect(mock.show).toHaveBeenCalledWith('dialog', { activeTab: 'deposit' });
    mock.status = 0;
    render(<BalanceBar/>);
    expect((actions()[0] as HTMLButtonElement).disabled).toBe(true);
    expect((actions()[1] as HTMLButtonElement).disabled).toBe(true);
    expect(actions()[2].getAttribute('href')).toBe('/portfolio');
    expect(container.textContent).toContain('—');
  });

  it('shows an in-flight deposit inside the bar and marks the account value as updating', () => {
    mock.history = [{ id: 'd1', tx_id: '0x1', side: 'DEPOSIT', amount: 25, fee: 0, trans_status: 'PENDING', created_time: Date.now() - 5000, chain_id: '1' }];
    render(<BalanceBar/>);
    const bar = container.querySelector('.nl-balance-bar')!;
    expect(bar.classList.contains('nl-balance-bar-pending')).toBe(true);
    expect(bar.querySelector('.nl-pending-strip')?.textContent).toContain('Deposit of $25.00 on its way');
    expect(bar.querySelector('.nl-label .nl-pending-dot')).not.toBeNull();
  });

  it('renders no strip or dot without transfers, and polls nothing while disconnected', () => {
    mock.history = [];
    render(<BalanceBar/>);
    expect(container.querySelector('.nl-pending-strip, .nl-pending-dot, .nl-balance-bar-pending')).toBeNull();
    mock.status = 0;
    render(<BalanceBar/>);
    expect(mock.query).toHaveBeenLastCalledWith(null, expect.anything());
  });

  it('starts a short watch poll when the transfer dialog opens', () => {
    mock.history = [];
    render(<BalanceBar/>);
    expect((mock.query.mock.calls.at(-1)?.[1] as any).refreshInterval).toBe(0);
    act(() => Simulate.click(actions()[0]));
    expect((mock.query.mock.calls.at(-1)?.[1] as any).refreshInterval).toBe(5000);
  });
});
