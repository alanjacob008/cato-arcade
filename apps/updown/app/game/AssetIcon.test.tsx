import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetIcon, assetIconUrls } from './AssetIcon';

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));
describe('market asset icons', () => {
  it('uses the official SDK symbol convention for ordinary and broker markets', () => {
    expect(assetIconUrls('PERP_SOL_USDC').primary).toBe('https://oss.orderly.network/static/symbol_logo/SOL.png');
    expect(assetIconUrls('PERP_XYZ_USDC_broker')).toEqual({ name: 'XYZ', primary: 'https://oss.orderly.network/static/broker_symbol_logo/XYZ_broker.png', fallback: 'https://oss.orderly.network/static/symbol_logo/XYZ.png' });
  });
  it('renders a real icon with an accessible name and a bounded fallback on errors', () => {
    act(() => root.render(<AssetIcon symbol="PERP_XYZ_USDC_broker"/>));
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('XYZ icon');
    act(() => Simulate.error(container.querySelector('img')!));
    expect(container.querySelector('img')?.src).toBe('https://oss.orderly.network/static/symbol_logo/XYZ.png');
    act(() => Simulate.error(container.querySelector('img')!));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('XY');
    act(() => root.render(<AssetIcon symbol="PERP_BTC_USDC"/>));
    expect(container.querySelector('img')?.src).toBe('https://oss.orderly.network/static/symbol_logo/BTC.png');
  });
});
