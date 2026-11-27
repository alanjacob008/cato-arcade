import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Balances, { inPlay } from './Balances';

const mock = vi.hoisted(() => ({
  status: 5,
  accountId: '0x' + 'a'.repeat(64) as string | undefined,
  collateral: { totalValue: 120, freeCollateral: 80, availableBalance: 90, usdcHolding: 100, unsettledPnL: -2.5 } as Record<string, number | null>,
  holdings: undefined as any[] | undefined,
  show: vi.fn(),
}));
vi.mock('@orderly.network/hooks', () => ({
  useAccount: () => ({ state: { status: mock.status, accountId: mock.accountId } }),
  useCollateral: () => mock.collateral,
  useHoldingStream: () => ({ data: mock.holdings, usdc: undefined, isLoading: false }),
  useIndexPricesStream: () => ({ data: {}, getIndexPrice: (t: string) => t === 'ETH' ? 2000 : 0 }),
}));
vi.mock('@orderly.network/ui', () => ({ modal: { show: (...a: unknown[]) => mock.show(...a) }, useScreen: () => ({ isMobile: false }) }));
vi.mock('@orderly.network/ui-transfer', () => ({ DepositAndWithdrawWithDialogId: 'dialog', DepositAndWithdrawWithSheetId: 'sheet' }));

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mock.status = 5; mock.accountId = '0x' + 'a'.repeat(64); mock.holdings = undefined;
  mock.collateral = { totalValue: 120, freeCollateral: 80, availableBalance: 90, usdcHolding: 100, unsettledPnL: -2.5 };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = () => act(() => root.render(<Balances/>));

describe('balances', () => {
  it('computes in-play money with a floor of zero', () => {
    expect(inPlay(120, 90)).toBe(30);
    expect(inPlay(50, 90)).toBe(0);
    expect(inPlay(null, 10)).toBe(0);
  });

  it('shows the wallet prompt and no figures when disconnected', () => {
    mock.status = 0; mock.accountId = undefined; render();
    expect(container.querySelector('.nl-empty img')!.getAttribute('src')).toMatch(/^\/updown\/cato\/.+\.webp$/);
    expect(container.textContent).toContain('Connect your wallet to see your balance.');
    expect(container.querySelector('table, .nl-balances-tile, button')).toBeNull();
  });

  it('shows in-play money, holdings and funding buttons when connected', () => {
    mock.holdings = [{ token: 'USDC', holding: 100 }, { token: 'ETH', holding: 0.01 }, { token: 'SOL', holding: 0 }];
    render();
    const tiles = [...container.querySelectorAll('.nl-balances-tile')].map(t => [t.querySelector('.nl-label')!.textContent, t.querySelector('strong')!.textContent]);
    expect(tiles).toEqual([['In play', '$30.00'], ['Free for new rounds', '$80.00'], ['Unsettled result', '−$2.50']]);
    expect(container.querySelectorAll('.nl-balances-tile strong')[2].className).toContain('nl-negative');
    // Same tile class as the Rounds tab so the tiles keep one size across tabs, plus a one-line caption.
    expect(container.querySelectorAll('.nl-stat-tiles > .nl-stat-tile')).toHaveLength(3);
    expect(container.querySelector('.nl-stat-tiles + .nl-stat-caption')!.textContent).toBe('How your money splits between open rounds and your next call.');

    expect([...container.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Asset', 'Balance', 'Value']);
    const rows = [...container.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent));
    expect(rows).toEqual([['USDC', '100.00', '$100.00'], ['ETH', '0.01', '$20.00']]);
    expect(container.querySelector('tbody .nl-coin')!.getAttribute('aria-label')).toBe('USDC icon');
    expect(container.textContent).not.toContain('Convert history');

    const [deposit, withdraw] = [...container.querySelectorAll('button')];
    act(() => deposit.click());
    expect(mock.show).toHaveBeenLastCalledWith('dialog', { activeTab: 'deposit' });
    act(() => withdraw.click());
    expect(mock.show).toHaveBeenLastCalledWith('dialog', { activeTab: 'withdraw' });
  });

  it('falls back to a USDC row from collateral before holdings load', () => {
    render();
    const rows = [...container.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent));
    expect(rows).toEqual([['USDC', '100.00', '$100.00']]);
  });
});
