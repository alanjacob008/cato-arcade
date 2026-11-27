import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./BalanceBar', () => ({ BalanceBar: () => <section className="nl-balance-bar"/> }));
vi.mock('./LiveRoundPanel', () => ({ LiveRoundPanel: () => null }));
import PortfolioLayout from './PortfolioLayout';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (path: string) => act(() => root.render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/portfolio" element={<PortfolioLayout/>}><Route index element={null}/><Route path="assets" element={null}/><Route path="history" element={null}/></Route>
</Routes></MemoryRouter>));

describe('portfolio layout', () => {
  it.each([
    ['/portfolio', 'Your rounds.', 'Every call you made, and how it ended.'],
    ['/portfolio/assets', 'Your balance.', 'What you have, and what is free to play.'],
    ['/portfolio/history', 'Your history.', 'Every deposit and withdrawal.'],
  ])('titles %s per tab and keeps the eyebrow', (path, title, subtitle) => {
    render(path);
    const heading = container.querySelector('.nl-page-heading')!;
    expect(heading.querySelector('.nl-eyebrow')!.textContent).toBe('YOUR GAME');
    expect(heading.querySelector('h1')!.textContent).toBe(title);
    expect(heading.querySelector('h1 + p')!.textContent).toBe(subtitle);
    // No hero cat: the heading keeps the game hero's height so the balance bar does not jump.
    expect(heading.querySelector('img')).toBeNull();
  });
});
