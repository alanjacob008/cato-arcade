import { useState } from 'react';

/** Same symbol and broker fallback convention as Orderly SDK 3.1.11 TokenIcon. */
export function assetIconUrls(symbol: string) {
  const parts = symbol.split('_');
  const name = parts.length >= 2 ? parts[1] : symbol;
  const broker = parts[3]?.trim();
  const base = 'https://oss.orderly.network/static';
  const fallback = `${base}/symbol_logo/${encodeURIComponent(name)}.png`;
  return { name, primary: broker ? `${base}/broker_symbol_logo/${encodeURIComponent(`${name}_${broker}`)}.png` : fallback, fallback };
}

export function AssetIcon({ symbol }: { symbol: string }) {
  return <AssetImage key={symbol} symbol={symbol}/>;
}

function AssetImage({ symbol }: { symbol: string }) {
  const { name, primary, fallback } = assetIconUrls(symbol);
  const [source, setSource] = useState<string | undefined>(primary);
  return <span className="nl-coin" role="img" aria-label={`${name} icon`}>
    {source ? <img src={source} alt="" width="37" height="37" loading="lazy" decoding="async" onError={() => setSource(source !== fallback ? fallback : undefined)}/>
      : <span aria-hidden="true">{name.slice(0, 2)}</span>}
  </span>;
}
