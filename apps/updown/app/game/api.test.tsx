import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGameQuery } from './api';

let root: Root, container: HTMLDivElement;
const fetchMock = vi.fn();
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
function Probe({ path = '/rounds?accountId=sol' }: { path?: string }) {
  const { data, error, refresh } = useGameQuery<{ value: string }>(path, 60000);
  return <><span>{data?.value || 'loading'}</span><small>{error}</small><button onClick={refresh}>Refresh</button></>;
}
const render = async (path?: string) => { await act(async () => root.render(<Probe path={path}/>)); };
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.setSystemTime(100000);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => response(url === '/game-api/session' ? { token: 'test-session' } : { value: 'first' }));
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('query recovery after tab switching', () => {
  it('retains the last good chart during refresh and during a transient failure', async () => {
    await render();
    let finish!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('span')?.textContent).toBe('first');
    await act(async () => finish(response({ value: 'second' })));
    expect(container.querySelector('span')?.textContent).toBe('second');
    fetchMock.mockRejectedValueOnce(new Error('Offline'));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('span')?.textContent).toBe('second');
    expect(container.querySelector('small')?.textContent).toBe('Offline');
  });
  it('refreshes immediately on return, replaces a stuck read, and ignores its late response', async () => {
    await render();
    let late!: (r: Response) => void;
    let oldSignal!: AbortSignal;
    fetchMock.mockImplementationOnce((_url, options) => { oldSignal = options.signal; return new Promise(resolve => { late = resolve; }); });
    await act(async () => container.querySelector('button')!.click());
    vi.setSystemTime(200000);
    fetchMock.mockResolvedValueOnce(response({ value: 'resumed' }));
    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    expect(oldSignal.aborted).toBe(true);
    expect(container.querySelector('span')?.textContent).toBe('resumed');
    await act(async () => late(response({ value: 'stale' })));
    expect(container.querySelector('span')?.textContent).toBe('resumed');
  });
  it('does not refresh on hiding, and refreshes on network recovery', async () => {
    await render();
    vi.setSystemTime(200000);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const calls = fetchMock.mock.calls.length;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(fetchMock.mock.calls.length).toBe(calls);
    hidden.mockReturnValue('visible');
    fetchMock.mockResolvedValueOnce(response({ value: 'online' }));
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(container.querySelector('span')?.textContent).toBe('online');
  });
  it('clears the old market on a symbol switch and ignores its in-flight response', async () => {
    await render();
    let late!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    await act(async () => container.querySelector('button')!.click());
    fetchMock.mockResolvedValueOnce(response({ value: 'BTC' }));
    await render('/rounds?accountId=btc');
    await act(async () => late(response({ value: 'SOL' })));
    expect(container.querySelector('span')?.textContent).toBe('BTC');
  });
});

describe('round service authentication', () => {
  it('echoes the local worker token, and sends none when the site session cookie authenticates', async () => {
    vi.resetModules();
    const local = await import('./api');
    await local.gameApi('/health');
    const localCall = fetchMock.mock.calls.find(([url]) => url === '/game-api/health')!;
    expect(localCall[1].headers['X-UpDown-Token']).toBe('test-session');
    vi.resetModules();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => response(url === '/game-api/session' ? { network: 'mainnet', wallet: 'w' } : { ready: true }));
    const site = await import('./api');
    await site.gameApi('/health');
    const siteCall = fetchMock.mock.calls.find(([url]) => url === '/game-api/health')!;
    expect(siteCall[1].headers).not.toHaveProperty('X-UpDown-Token');
    expect(siteCall[1].credentials).toBe('same-origin');
  });
});
