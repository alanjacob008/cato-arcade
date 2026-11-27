import { useEffect, useRef, useState } from 'react';
import type { Round } from './api';
import { clockTime, maxRoundDuration, roundDurations } from './timing';

/**
 * "Add time" for the running round: four big duration chips, available for the whole round (not only in its last
 * minute). Hovering or focusing a chip previews the new end time; the total round length is capped server-side at
 * maxRoundDuration, so chips that would exceed it are disabled. Sits with "Close round early" in the round controls.
 */
export function RoundExtension({ round, now, disabled, onExtend }: { round: Round; now: number; disabled: boolean; onExtend: (seconds: number, id: string) => Promise<void> }) {
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<number>();
  const [pending, setPending] = useState<number>();
  const request = useRef<{ id: string; seconds: number }>();
  const remaining = (round.deadline || 0) - now;
  const eligible = round.status === 'open' && remaining > 0;
  useEffect(() => { request.current = undefined; setError(''); setPending(undefined); setPreview(undefined); }, [round.id]);
  useEffect(() => {
    if (request.current && round.extensions?.some(extension => extension.id === request.current?.id)) {
      request.current = undefined; setError(''); setPending(undefined);
    }
  }, [round.extensions]);
  async function add(seconds: number) {
    if (!eligible || disabled) return;
    if (request.current && request.current.seconds !== seconds) return;
    if (!request.current) request.current = { seconds, id: crypto.randomUUID().replaceAll('-', '') };
    const current = request.current;
    setError(''); setPending(seconds);
    try { await onExtend(seconds, current.id); if (request.current?.id === current.id) { request.current = undefined; setPending(undefined); } }
    catch (e) { if (request.current?.id === current.id) { setError(e instanceof Error ? e.message : 'Could not confirm the time extension.'); setPending(undefined); } }
  }
  if (!eligible) return error ? <p className="nl-error" role="alert">{error}</p> : null;
  const fits = (seconds: number) => round.duration + seconds <= maxRoundDuration;
  const previewed = preview ?? pending;
  const hint = pending ? `Adding ${pending / 60} minutes…`
    : previewed && round.deadline ? `Ends at ${clockTime(round.deadline + previewed * 1000)}`
    : 'Added to the current timer. Liquidation risk continues.';
  return <div className="nl-extension">
    <div className="nl-extension-head"><span className="nl-extension-label">Add time</span><span className={`nl-extension-hint${pending ? ' nl-extension-pending' : ''}`} aria-live="polite">{hint}</span></div>
    <div className="nl-duration nl-extension-chips" role="group" aria-label="Add time to this round" onMouseLeave={() => setPreview(undefined)}>
      {roundDurations.map(([seconds, label]) => {
        const blocked = disabled || !fits(seconds) || Boolean(request.current && request.current.seconds !== seconds);
        return <button key={seconds} type="button" disabled={blocked} aria-busy={pending === seconds || undefined}
          title={fits(seconds) ? (round.deadline ? `Ends at ${clockTime(round.deadline + seconds * 1000)}` : undefined) : `Rounds run at most ${maxRoundDuration / 3600} hours in total`}
          onMouseEnter={() => setPreview(seconds)} onFocus={() => setPreview(seconds)} onBlur={() => setPreview(undefined)}
          onClick={() => void add(seconds)}>+{label}</button>;
      })}
    </div>
    {error && <p className="nl-error" role="alert">{error}</p>}
  </div>;
}
