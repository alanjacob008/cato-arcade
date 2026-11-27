import { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmountInput } from './AmountInput';
import { AmountContext } from './amounts';
import { Market } from './api';

const context: AmountContext = { market: { maxLeverage: 100, base_imr: .01, imr_factor: .000001,
  base_min: .01, base_tick: .01, min_notional: 10 } as Market, price: 100, freeCollateral: 9.36,
  feeRate: .0003, leverageOverride: null, accountReady: true };
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
function Harness({ disabled = false, ready = true, balance = 9.36, initial = '5' }: { disabled?: boolean; ready?: boolean; balance?: number; initial?: string }) {
  const [value, setValue] = useState(initial);
  return <AmountInput value={value} onChange={setValue} context={{ ...context, accountReady: ready, freeCollateral: balance }} disabled={disabled}/>;
}
const input = () => container.querySelector<HTMLInputElement>('#round-amount')!;
const slider = () => container.querySelector<HTMLInputElement>('.nl-stake-slider input[type="range"]')!;
const chips = () => [...container.querySelectorAll<HTMLButtonElement>('.nl-amount-presets button')];

describe('amount controls', () => {
  it('slides over the usable balance and keeps the number field in step', () => {
    act(() => root.render(<Harness/>));
    expect(slider().min).toBe('0');
    expect(slider().max).toBe('8.46');
    expect(slider().step).toBe('0.01');
    expect(slider().value).toBe('5');
    expect(container.querySelector('.nl-available')?.textContent).toBe('of $8.46 availableMin $0.10');
    act(() => { slider().value = '3.3'; Simulate.change(slider()); });
    expect(input().value).toBe('3.30');
    act(() => { input().value = '7'; Simulate.change(input()); });
    expect(slider().value).toBe('7');
    // Typing past the balance pins the thumb at the end; the field keeps what was typed.
    act(() => { input().value = '12'; Simulate.change(input()); });
    expect(slider().value).toBe('8.46');
    expect(input().value).toBe('12');
    expect((container.querySelector('.nl-stake-slider') as HTMLElement).style.getPropertyValue('--nl-share')).toBe('100%');
  });
  it('offers shares of the balance as chips, marks the one in use, and uses Max inside the input', () => {
    act(() => root.render(<Harness/>));
    expect(chips().map(button => button.textContent)).toEqual(['10%', '25%', '50%', '75%', 'All']);
    expect(chips().every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    act(() => chips()[2].click());
    expect(input().value).toBe('4.23');
    expect(slider().value).toBe('4.23');
    expect(chips()[2].getAttribute('aria-pressed')).toBe('true');
    act(() => chips()[4].click());
    expect(input().value).toBe('8.46');
    expect(chips()[4].getAttribute('aria-pressed')).toBe('true');
    expect(chips()[2].getAttribute('aria-pressed')).toBe('false');
    act(() => { input().value = '1'; Simulate.change(input()); });
    const max = container.querySelector<HTMLButtonElement>('.nl-amount-input button')!;
    expect(max.textContent).toBe('Max');
    act(() => max.click());
    expect(input().value).toBe('8.46');
  });
  it('explains a stake under the market minimum and disables shares that would land there', () => {
    act(() => root.render(<Harness balance={.6} initial="0.05"/>));
    expect(slider().max).toBe('0.54');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('.nl-field-error')?.textContent).toBe('Stakes start at $0.10. Move the slider up a little.');
    expect(container.querySelector('.nl-min-stake')?.className).toContain('nl-min-stake-hit');
    // 10% of $0.54 is $0.05: under the minimum, so that chip is off; 25% ($0.13) is fine.
    expect(chips().map(button => button.disabled)).toEqual([true, false, false, false, false]);
    act(() => chips()[1].click());
    expect(input().value).toBe('0.13');
    expect(container.querySelector('.nl-field-error')).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBeNull();
  });
  it('locks entry, slider, chips and Max while busy, the wallet is not ready, or there is nothing to play with', () => {
    for (const props of [{ disabled: true }, { ready: false }, { balance: 0 }]) {
      act(() => root.render(<Harness {...props}/>));
      expect(input().disabled).toBe(props.balance === 0 ? false : true);
      expect(slider().disabled).toBe(true);
      expect([...container.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true);
    }
    act(() => root.render(<Harness ready={false}/>));
    expect(container.querySelector('.nl-available')?.textContent).toBe('Connect a wallet to see your balance');
  });
});
