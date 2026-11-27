import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MuteButton } from './MuteButton';
import { SfxProvider, useSfx } from './SfxProvider';
import { createSfxEngine, MUTED_KEY, type SfxEngine } from './sfx';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

function engine(): SfxEngine {
  return createSfxEngine({ createContext: () => null, fetchFile: async () => new ArrayBuffer(0) });
}
const render = (e: SfxEngine, ui = <MuteButton/>) => act(() => root.render(<SfxProvider engine={e}>{ui}</SfxProvider>));
const button = () => container.querySelector<HTMLButtonElement>('button.nl-mute')!;

describe('MuteButton', () => {
  it('shows sound on by default, toggles, and persists the choice', () => {
    const e = engine();
    render(e);
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().getAttribute('aria-label')).toBe('Sound on');
    expect(button().textContent).toBe('Sound on');
    act(() => { button().click(); });
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().getAttribute('aria-label')).toBe('Sound off');
    expect(button().dataset.muted).toBe('true');
    expect(e.muted).toBe(true);
    expect(localStorage.getItem(MUTED_KEY)).toBe('1');
    act(() => { button().click(); });
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(MUTED_KEY)).toBe('0');
  });

  it('starts muted when the stored choice says so', () => {
    localStorage.setItem(MUTED_KEY, '1');
    render(engine());
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().textContent).toBe('Sound off');
  });

  it('follows changes made elsewhere through the engine', () => {
    const e = engine();
    function Other() { const { muted, setMuted } = useSfx(); return <button className="other" onClick={() => setMuted(!muted)}>{String(muted)}</button>; }
    render(e, <><MuteButton/><Other/></>);
    act(() => { (container.querySelector('button.other') as HTMLButtonElement).click(); });
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('button.other')!.textContent).toBe('true');
  });

  it('installs the gesture listeners while mounted', () => {
    const e = engine();
    const install = vi.spyOn(e, 'install');
    render(e);
    expect(install).toHaveBeenCalledTimes(1);
  });
});
