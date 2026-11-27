import type { CSSProperties } from 'react';
import { dollars } from './api';
import { AmountContext, amountQuote, maximumAmount, minimumAmount, percentAmount, STAKE_PERCENTS } from './amounts';
import './amount-input.css';

type Props = { value: string; onChange: (value: string) => void; context: AmountContext; disabled?: boolean };

/** The stake: a big editable number, a slider over the usable balance, and quick shares of it. Field and slider stay in sync. */
export function AmountInput({ value, onChange, context, disabled = false }: Props) {
  const ready = amountQuote(.01, context).ready;
  const maximum = maximumAmount(context);
  const minimum = minimumAmount(context);
  const locked = disabled || !ready;
  const amount = Number(value);
  const sliderValue = Number.isFinite(amount) ? Math.min(maximum, Math.max(0, amount)) : 0;
  const cents = Number.isFinite(amount) ? Math.round(amount * 100) : -1;
  const belowMinimum = ready && amount > 0 && minimum > 0 && amount < minimum;
  const share = maximum > 0 && Number.isFinite(amount) ? Math.min(100, Math.max(0, amount / maximum * 100)) : 0;
  return <>
    <label className="nl-field-label" htmlFor="round-amount">Your stake</label>
    <div className="nl-amount-input"><span className="nl-amount-field"><span className="nl-amount-currency" aria-hidden="true">$</span><input id="round-amount" type="number" inputMode="decimal" min="0.01" step="0.01" value={value} onChange={e => onChange(e.target.value)} disabled={locked} aria-invalid={belowMinimum || undefined}/></span><button type="button" className="nl-amount-max" aria-label="Use maximum available amount" disabled={locked || maximum <= 0} onClick={() => onChange(maximum.toFixed(2))}>Max</button><b>USDC</b></div>
    <div className="nl-stake-slider" style={{ '--nl-share': `${share}%` } as CSSProperties}>
      <input type="range" aria-label="Stake amount" min={0} max={maximum} step={.01} value={sliderValue} disabled={locked || maximum <= 0} onChange={e => onChange(Number(e.target.value).toFixed(2))}/>
    </div>
    <div className="nl-amount-presets" role="group" aria-label="Stake as a share of your balance">{STAKE_PERCENTS.map(percent => {
      const target = percentAmount(context, percent);
      const selected = target > 0 && Math.round(target * 100) === cents;
      return <button type="button" key={percent} disabled={locked || target <= 0 || !amountQuote(target, context).affordable} aria-pressed={selected} className={selected ? 'selected' : ''} onClick={() => onChange(target.toFixed(2))}>{percent === 100 ? 'All' : `${percent}%`}</button>;
    })}</div>
    <p className="nl-available"><span>{context.accountReady ? ready ? <>of <b>{dollars(maximum)}</b> available</> : 'Updating your balance…' : 'Connect a wallet to see your balance'}</span>{ready && minimum > 0 && <span className={belowMinimum ? 'nl-min-stake nl-min-stake-hit' : 'nl-min-stake'}>Min {dollars(minimum)}</span>}</p>
    {belowMinimum && <p className="nl-field-error" role="alert">Stakes start at {dollars(minimum)}. Move the slider up a little.</p>}
  </>;
}
