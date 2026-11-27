import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DepositHistory, { LEDGER_PAGE, ledgerWhen, shortHash } from './DepositHistory';

const mock = vi.hoisted(() => ({
  status: 5,
  accountId: '0x' + 'a'.repeat(64) as string | undefined,
  rows: [] as any[],
  total: 0,
  isLoading: false,
  options: [] as any[],
}));
vi.mock('@orderly.network/hooks', () => ({
  useAccount: () => ({ state: { status: mock.status, accountId: mock.accountId } }),
  useAssetsHistory: (options: any) => { mock.options.push(options); return [mock.rows, { meta: { total: mock.total, records_per_page: options.pageSize, current_page: 1 }, isLoading: mock.isLoading }]; },
  useChainInfo: () => ({ data: [{ chain_id: '42161', explorer_base_url: 'https://arbiscan.io' }] }),
}));

const SOL_TX = '3kF9' + 'x'.repeat(80) + 'a2Qc';
const base = { token: 'USDC', fee: 0, trans_status: 'COMPLETED', chain_id: '900900900', updated_time: 0 };
const deposit = { ...base, id: 'd1', side: 'DEPOSIT', amount: 25, tx_id: SOL_TX, created_time: Date.UTC(2026, 9, 1, 10) };
const withdraw = { ...base, id: 'w1', side: 'WITHDRAW', amount: 10, fee: 1, tx_id: '0x' + 'b'.repeat(64), chain_id: '42161', created_time: Date.UTC(2026, 9, 5, 10), trans_status: 'PROCESSING' };
const latest = { ...base, id: 'd2', side: 'DEPOSIT', amount: 5, tx_id: '', created_time: Date.UTC(2026, 9, 8, 10), trans_status: 'FAILED' };

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(mock, { status: 5, accountId: '0x' + 'a'.repeat(64), rows: [], total: 0, isLoading: false, options: [] });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = () => act(() => root.render(<DepositHistory/>));
const cells = (i: number) => [...container.querySelectorAll('tbody tr')[i].querySelectorAll('td')].map(td => td.textContent);

describe('deposit and withdrawal history', () => {
  it('shows deposits and withdrawals in one table, newest first, with signed amounts', () => {
    mock.rows = [deposit, latest, withdraw]; mock.total = 3; render();
    expect([...container.querySelectorAll('thead th')].map(th => th.textContent)).toEqual(['Type', 'Time', 'Amount', 'Status', 'Tx']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(cells(0)).toEqual(['Deposit', ledgerWhen(latest.created_time), '+$5.00', 'Failed', '—']);
    expect(cells(1)).toEqual(['Withdraw', ledgerWhen(withdraw.created_time), '−$9.00', 'Pending', shortHash(withdraw.tx_id)]);
    expect(cells(2)).toEqual(['Deposit', ledgerWhen(deposit.created_time), '+$25.00', 'Completed', '3kF9…a2Qc']);

    const amounts = [...container.querySelectorAll('.nl-ledger-amount')];
    expect(amounts.map(a => a.className.includes('nl-positive'))).toEqual([true, false, true]);
    expect(amounts[1].className).toContain('nl-negative');
    expect(container.querySelectorAll('.nl-ledger-deposit')).toHaveLength(2);
    expect(container.querySelectorAll('.nl-ledger-withdraw')).toHaveLength(1);
  });

  it('asks for every side at once with one large page and no date range', () => {
    mock.rows = [deposit]; mock.total = 1; render();
    expect(mock.options.at(-1)).toEqual({ page: 1, pageSize: LEDGER_PAGE });
  });

  it('links transactions to the chain explorer, Solscan for Solana', () => {
    mock.rows = [deposit, withdraw]; mock.total = 2; render();
    const links = [...container.querySelectorAll<HTMLAnchorElement>('a.nl-ledger-tx')];
    expect(links.map(a => a.href)).toEqual([`https://arbiscan.io/tx/${withdraw.tx_id}`, `https://solscan.io/tx/${SOL_TX}`]);
    expect(links.every(a => a.target === '_blank' && a.rel === 'noreferrer')).toBe(true);
  });

  it('has no SDK filters: no calendar, wallet or account selector, no sub-tabs', () => {
    mock.rows = [deposit, withdraw]; mock.total = 2; render();
    const text = container.textContent!;
    for (const banned of ['Web3 wallet', 'Account ID', 'Deposits', 'Withdrawals', 'Rows per page', 'Funding']) expect(text).not.toContain(banned);
    expect(container.querySelector('input, select, [role=tablist], [role=tab]')).toBeNull();
  });

  it('offers Load more only while the server has more rows, growing the single request', () => {
    mock.rows = [deposit, withdraw]; mock.total = 2; render();
    expect(container.querySelector('.nl-ledger-more')).toBeNull();
    mock.total = 80; render();
    const button = container.querySelector<HTMLButtonElement>('.nl-ledger-more button')!;
    expect(button.textContent).toBe('Load more');
    act(() => button.click());
    expect(mock.options.at(-1)).toEqual({ page: 1, pageSize: LEDGER_PAGE * 2 });
  });

  it('shows loading, empty and disconnected states', () => {
    mock.isLoading = true; render();
    expect(container.textContent).toContain('Loading…');
    mock.isLoading = false; render();
    expect(container.querySelector('.nl-empty img')!.getAttribute('src')).toMatch(/^\/updown\/cato\/.+\.webp$/);
    expect(container.textContent).toContain('No deposits or withdrawals yet.');
    mock.status = 0; mock.accountId = undefined; render();
    expect(container.textContent).toContain('Connect your wallet to see your history.');
    expect(container.querySelector('table')).toBeNull();
  });
});
