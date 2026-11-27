// The footer's speaker toggle. Sound is on by default; the choice persists (localStorage) through the engine.
import { Volume2, VolumeX } from 'lucide-react';
import { useSfx } from './SfxProvider';

export function MuteButton({ className = '' }: { className?: string }) {
  const { muted, toggle, play } = useSfx();
  const label = muted ? 'Sound off' : 'Sound on';
  return (
    <button
      type="button"
      className={`nl-mute ${className}`.trim()}
      aria-pressed={!muted}
      aria-label={label}
      title={muted ? 'Turn sound on' : 'Turn sound off'}
      data-muted={muted}
      onClick={() => {
        toggle();
        // confirm the new state audibly only when turning sound on (toggle() flips synchronously)
        if (muted) play('ui-click');
      }}
    >
      {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}
