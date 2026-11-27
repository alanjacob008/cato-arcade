import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoundExtension } from './RoundExtension';
import { clockTime, countdown, maxRoundDuration } from './timing';
import type { Round } from './api';

const round: Round = { id: 'round-one', accountId: 'test', symbol: 'PERP_SOL_USDC', direction: 'UP', status: 'open', duration: 300, margin: 5, leverage: 100, quantity: 1, createdAt: 1000, deadline: 100000 };
let container: HTMLDivElement, root: Root;
const extend = vi.fn();
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); root = createRoot(container); extend.mockReset();
});
afterEach(() => act(() => root.unmount()));
const render = (now = 50000, current = round) => act(() => root.render(<RoundExtension round={current} now={now} disabled={false} onExtend={extend}/>));
const choices = () => [...container.querySelectorAll<HTMLButtonElement>('.nl-duration button')];
const hint = () => container.querySelector('.nl-extension-hint')?.textContent;

describe('round time extension', () => {
  it('is available for the whole open round, and hides at expiry and while closing', () => {
    // Right after the fill, with the full round ahead, as well as in the last minute.
    render(1000); expect(container.textContent).toContain('Add time');
    render(40000); expect(container.textContent).toContain('Add time');
    render(99999); expect(container.textContent).toContain('Add time');
    render(100000); expect(container.textContent).toBe('');
    render(50000, { ...round, status: 'closing' }); expect(container.textContent).toBe('');
  });
  it('offers four big chips without a popover and sends an idempotency ID with the chosen increment', async () => {
    extend.mockResolvedValue(undefined); render();
    expect(container.querySelector('.nl-extension-pop')).toBeNull();
    expect(container.querySelector('[aria-expanded]')).toBeNull();
    expect(container.querySelector('.nl-extension > .nl-extension-chips.nl-duration')).not.toBeNull();
    expect(choices().map(button => button.textContent)).toEqual(['+5m', '+10m', '+15m', '+30m']);
    await act(async () => choices()[2].click());
    expect(extend).toHaveBeenCalledWith(900, expect.stringMatching(/^[a-zA-Z0-9_-]{8,48}$/));
    expect(choices().every(button => !button.disabled)).toBe(true);
  });
  it('previews the new end time on hover and focus', () => {
    render();
    expect(hint()).toBe('Added to the current timer. Liquidation risk continues.');
    act(() => { choices()[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); });
    // React attaches mouseenter through mouseover/mouseout; drive it the same way the browser does.
    act(() => { choices()[1].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(hint()).toBe(`Ends at ${clockTime(100000 + 600 * 1000)}`);
    act(() => { container.querySelector('.nl-extension-chips')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
    expect(hint()).toBe('Added to the current timer. Liquidation risk continues.');
    act(() => { choices()[3].dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    expect(hint()).toBe(`Ends at ${clockTime(100000 + 1800 * 1000)}`);
    expect(choices()[3].title).toBe(`Ends at ${clockTime(100000 + 1800 * 1000)}`);
    act(() => { choices()[3].dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(hint()).toBe('Added to the current timer. Liquidation risk continues.');
  });
  it('disables increments that would push the round past the two-hour cap', () => {
    render(50000, { ...round, duration: maxRoundDuration - 900 });
    expect(choices().map(button => button.disabled)).toEqual([false, false, false, true]);
    expect(choices()[3].title).toContain('at most 2 hours');
    render(50000, { ...round, duration: maxRoundDuration });
    expect(choices().every(button => button.disabled)).toBe(true);
  });
  it('shows a pending state and retries an unconfirmed increment with the same ID, blocking a different increment until reconciliation', async () => {
    let fail!: (error: Error) => void;
    extend.mockImplementation(() => new Promise<void>((_, reject) => { fail = reject; }));
    render();
    await act(async () => { choices()[0].click(); });
    expect(hint()).toBe('Adding 5 minutes…');
    expect(choices()[0].getAttribute('aria-busy')).toBe('true');
    expect(choices().map(button => button.disabled)).toEqual([false, true, true, true]);
    await act(async () => fail(new Error('Connection interrupted')));
    expect(container.textContent).toContain('Connection interrupted');
    expect(choices().map(button => button.disabled)).toEqual([false, true, true, true]);
    const id = extend.mock.calls[0][1];
    extend.mockRejectedValue(new Error('Connection interrupted'));
    await act(async () => choices()[0].click());
    expect(extend.mock.calls[1]).toEqual([300, id]);
    render(50000, { ...round, extensions: [{ id, seconds: 300, acceptedAt: 49000, deadline: 400000 }] });
    expect(container.textContent).not.toContain('Connection interrupted');
    expect(choices().every(button => !button.disabled)).toBe(true);
  });
  it('formats the countdown as minutes:seconds, including more than an hour', () => {
    expect([0, 9, 30, 59.9, 60, 300, 3900].map(countdown)).toEqual(['0:00', '0:09', '0:30', '1:00', '1:00', '5:00', '65:00']);
  });
  it('does not show a late transport error after polling already confirmed the extension', async () => {
    let reject!: (error: Error) => void;
    extend.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail; }));
    render();
    await act(async () => { choices()[0].click(); });
    const id = extend.mock.calls[0][1];
    render(50000, { ...round, extensions: [{ id, seconds: 300, acceptedAt: 49000, deadline: 400000 }] });
    await act(async () => reject(new Error('Late timeout')));
    expect(container.textContent).not.toContain('Late timeout');
  });
});
