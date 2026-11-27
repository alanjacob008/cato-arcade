import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSfxEngine, MUTED_KEY, SFX_NAMES, type SfxContext } from './sfx';

/** A fake AudioContext that records what was started. */
function fakeContext() {
  const started: { buffer: unknown; loop: boolean; rate: number; gain: number }[] = [];
  const stopped: number[] = [];
  const param = (v = 1) => ({ value: v, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() });
  const master = { gain: param(1), connect: vi.fn() };
  let gainsCreated = 0;
  const ctx = {
    state: 'running' as AudioContextState,
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    createGain: vi.fn(() => (gainsCreated++ === 0 ? master : { gain: param(1), connect: vi.fn() })),
    createBufferSource: vi.fn(() => {
      let gainNode: { gain: { value: number } } | null = null;
      const src = {
        buffer: null as unknown, loop: false, playbackRate: param(1),
        connect: vi.fn((g: { gain: { value: number } }) => { gainNode = g; }),
        start: vi.fn(() => started.push({ buffer: src.buffer, loop: src.loop, rate: src.playbackRate.value, gain: gainNode?.gain.value ?? 1 })),
        stop: vi.fn((t: number) => stopped.push(t)),
      };
      return src;
    }),
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => ({ length: bytes.byteLength, duration: 0.1 } as unknown as AudioBuffer)),
    resume: vi.fn(async () => { ctx.state = 'running'; }),
    suspend: vi.fn(async () => { ctx.state = 'suspended'; }),
  };
  return { ctx: ctx as unknown as SfxContext, started, stopped, master, raw: ctx };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeEngine(overrides: Parameters<typeof createSfxEngine>[0] = {}) {
  const fake = fakeContext();
  const fetched: string[] = [];
  const engine = createSfxEngine({
    createContext: () => fake.ctx,
    fetchFile: async (url) => { fetched.push(url); return new ArrayBuffer(8); },
    base: '/sfx/', ext: 'ogg',
    ...overrides,
  });
  return { engine, fake, fetched };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('sfx engine', () => {
  it('knows only the game sounds (no cat foley)', () => {
    expect([...SFX_NAMES]).toEqual(['call-up', 'call-down', 'filled', 'win', 'win-big', 'loss', 'tick', 'tick-final', 'close', 'ui-click']);
    expect(SFX_NAMES.some((n) => n.startsWith('cat-'))).toBe(false);
  });

  it('is on by default and persists mute to localStorage', () => {
    const { engine } = makeEngine();
    expect(engine.muted).toBe(false);
    engine.setMuted(true);
    expect(localStorage.getItem(MUTED_KEY)).toBe('1');
    expect(engine.muted).toBe(true);
    // a fresh engine reads the stored choice back
    expect(makeEngine().engine.muted).toBe(true);
    engine.setMuted(false);
    expect(localStorage.getItem(MUTED_KEY)).toBe('0');
    expect(makeEngine().engine.muted).toBe(false);
  });

  it('notifies subscribers on mute changes only', () => {
    const { engine } = makeEngine();
    const seen: boolean[] = [];
    const off = engine.subscribe((m) => seen.push(m));
    engine.setMuted(true); engine.setMuted(true); engine.toggleMuted();
    expect(seen).toEqual([true, false]);
    off();
    engine.setMuted(true);
    expect(seen).toEqual([true, false]);
  });

  it('creates the AudioContext only on a user gesture, then plays', async () => {
    const { engine, fake, fetched } = makeEngine();
    const uninstall = engine.install();
    engine.preload(['filled']);
    engine.play('filled');
    expect(engine.unlocked).toBe(false);
    expect(fetched).toEqual([]);
    expect(fake.started).toHaveLength(0);
    document.dispatchEvent(new Event('pointerdown'));
    expect(engine.unlocked).toBe(true);
    await flush();
    expect(fetched).toEqual(['/sfx/filled.ogg']);
    engine.play('filled', { rate: 1.1, gain: 0.5 });
    expect(fake.started).toEqual([{ buffer: expect.objectContaining({ length: 8 }), loop: false, rate: 1.1, gain: 0.5 }]);
    uninstall();
    engine.dispose();
  });

  it('decodes once per file and plays a not-yet-decoded sound when it arrives quickly', async () => {
    const { engine, fake, fetched } = makeEngine();
    engine.unlock();
    engine.play('win'); engine.play('win');
    expect(fetched).toEqual(['/sfx/win.ogg']);
    await flush();
    expect(fake.started).toHaveLength(2);
    engine.play('win');
    expect(fetched).toHaveLength(1);
    expect(fake.started).toHaveLength(3);
  });

  it('drops a sound that decoded too late', async () => {
    vi.useFakeTimers();
    let release!: (b: ArrayBuffer) => void;
    const { engine, fake } = makeEngine({ fetchFile: () => new Promise((r) => { release = r; }) });
    engine.unlock();
    engine.play('loss');
    vi.advanceTimersByTime(1000);
    release(new ArrayBuffer(8));
    await vi.runAllTimersAsync();
    expect(fake.started).toHaveLength(0);
    vi.useRealTimers();
  });

  it('plays nothing while muted or hidden, and the master gain follows mute', async () => {
    const { engine, fake } = makeEngine();
    engine.unlock();
    engine.preload(['tick']);
    await flush();
    engine.setMuted(true);
    engine.play('tick');
    expect(fake.started).toHaveLength(0);
    expect(fake.master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.02);
    engine.setMuted(false);
    expect(fake.master.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.02);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    engine.play('tick');
    expect(fake.started).toHaveLength(0);
    vi.restoreAllMocks();
    engine.play('tick');
    expect(fake.started).toHaveLength(1);
  });

  it('suspends the context when the page hides and resumes when it shows', () => {
    const { engine, fake } = makeEngine();
    const uninstall = engine.install();
    engine.unlock();
    const vis = vi.spyOn(document, 'visibilityState', 'get');
    vis.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fake.raw.suspend).toHaveBeenCalledTimes(1);
    fake.raw.state = 'suspended';
    vis.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fake.raw.resume).toHaveBeenCalled();
    uninstall();
  });

  it('loops until stopped, with a fade', async () => {
    const { engine, fake } = makeEngine();
    engine.unlock();
    const handle = engine.loop('tick');
    await flush();
    expect(fake.started).toEqual([expect.objectContaining({ loop: true })]);
    expect(handle.playing).toBe(true);
    handle.stop(100);
    expect(handle.playing).toBe(false);
    expect(fake.stopped[0]).toBeCloseTo(0.11, 5);
    // stopping before the buffer arrived never starts it
    const early = engine.loop('tick');
    early.stop();
    await flush();
    expect(fake.started).toHaveLength(1);
  });

  it('does nothing without Web Audio', () => {
    const engine = createSfxEngine({ createContext: () => null, fetchFile: async () => new ArrayBuffer(0) });
    engine.unlock();
    expect(engine.unlocked).toBe(false);
    expect(() => engine.play('win')).not.toThrow();
    expect(engine.loop('tick').playing).toBe(false);
  });
});
