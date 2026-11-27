"""Read-only candle study. No wallet, credentials or trading endpoints.

Compares completed close-to-close moves, not executable bid/ask returns.
One-minute candles cannot measure a 30-second horizon. Overlapping samples
are descriptive observations, not independent trials or predicted win rates.
Run: python research/fee_frequency.py
"""
import csv
import json
import math
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from statistics import median

OUTPUT = Path(__file__).parent / 'results'
SYMBOLS = ['PERP_SOL_USDC', 'PERP_BTC_USDC', 'PERP_ETH_USDC']
FEE = 0.0003


def utc(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


def query(body):
    request = urllib.request.Request('https://api.orderly.org/v1/public/query', json.dumps(body).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)
    if not result.get('success'):
        raise RuntimeError(result.get('message', 'Orderly query failed'))
    return result['data']


def sample(rows, minutes, step=1, buffer_bps=0):
    pairs = []
    for i in range(0, len(rows) - minutes, step):
        end = i + minutes
        if rows[end]['timestamp'] - rows[i]['timestamp'] != minutes * 60000:
            continue
        entry, exit_ = float(rows[i]['close']), float(rows[end]['close'])
        move = exit_ / entry - 1
        # Normalized by entry notional. Fee on actual entry + exit notionals.
        cost = FEE * (1 + exit_ / entry) + buffer_bps / 10000
        intermediate = rows[i + 1:end + 1]
        up_touch = max(float(r['high']) for r in intermediate) / entry > (1 + FEE + buffer_bps / 10000) / (1 - FEE)
        down_touch = min(float(r['low']) for r in intermediate) / entry < (1 - FEE - buffer_bps / 10000) / (1 + FEE)
        pairs.append((move, cost, up_touch, down_touch))
    n = len(pairs)
    rises = [p for p in pairs if p[0] > 0]
    falls = [p for p in pairs if p[0] < 0]
    up_wins = sum(p[0] > p[1] for p in rises)
    down_wins = sum(-p[0] > p[1] for p in falls)
    pct = lambda a, b: round(100 * a / b, 3) if b else None
    return {
        'duration_seconds': minutes * 60, 'entry_step_minutes': step,
        'extra_cost_buffer_bps': buffer_bps, 'windows': n,
        'rising_windows': len(rises), 'falling_windows': len(falls), 'flat_windows': n - len(rises) - len(falls),
        'correct_up_covers_cost_pct': pct(up_wins, len(rises)),
        'correct_down_covers_cost_pct': pct(down_wins, len(falls)),
        'correct_direction_covers_cost_pct': pct(up_wins + down_wins, len(rises) + len(falls)),
        'any_direction_covers_cost_at_exit_pct': pct(up_wins + down_wins, n),
        'always_up_net_positive_pct': pct(up_wins, n),
        'always_down_net_positive_pct': pct(down_wins, n),
        'uniform_random_direction_net_positive_pct': pct(up_wins + down_wins, 2 * n),
        'either_direction_touched_cost_barrier_pct': pct(sum(p[2] or p[3] for p in pairs), n),
        'median_absolute_move_pct': round(median(abs(p[0]) for p in pairs) * 100, 5) if n else None,
    }


def main():
    OUTPUT.mkdir(exist_ok=True)
    now = int(time.time() * 1000)
    requested_start = now - 7 * 86400000
    series = {}
    for symbol in SYMBOLS:
        candles = {}
        cursor = None
        for page in range(10):
            body = {'type': 'candles', 'symbol': symbol, 'interval': '1m', 'start_time': requested_start, 'end_time': now, 'limit': 5000}
            if cursor:
                body['cursor'] = cursor
            data = query(body)
            for r in data['rows']:
                if r['timestamp'] + 60000 <= now and all(math.isfinite(float(r[k])) and float(r[k]) > 0 for k in ['open', 'high', 'low', 'close']):
                    candles[r['timestamp']] = r
            next_cursor = data.get('next_cursor')
            if not next_cursor:
                break
            if next_cursor == cursor:
                raise RuntimeError('Repeated pagination cursor')
            cursor = next_cursor
        else:
            raise RuntimeError('Pagination incomplete')
        series[symbol] = sorted(candles.values(), key=lambda r: r['timestamp'])
        if not series[symbol]:
            raise RuntimeError(f'No candles for {symbol}')
        (OUTPUT / f'{symbol}-candles.json').write_text(json.dumps(series[symbol]), encoding='utf-8')
    start = max(rows[0]['timestamp'] for rows in series.values())
    end = min(rows[-1]['timestamp'] for rows in series.values())
    report = {
        'collected_at_utc': utc(now), 'requested_start_utc': utc(requested_start),
        'actual_first_close_utc': utc(start + 60000), 'actual_last_close_utc': utc(end + 60000),
        'source': 'https://api.orderly.org/v1/public/query', 'fee_bps_each_side': FEE * 10000,
        'up_fee_only_break_even_move_pct': 2 * FEE / (1 - FEE) * 100,
        'down_fee_only_break_even_move_pct': 2 * FEE / (1 + FEE) * 100,
        'limits': [
            'One-minute data cannot establish 30-second outcomes.',
            'Returned history was shorter than the requested seven days; actual timestamps govern the study.',
            'Candle prices are trade/mid-price proxies, not executable entry/exit fills.',
            'No liquidation, funding, latency or orderbook simulation. Fee-only results can overstate executable profitability.',
            'Correct-direction metric assumes the winning direction was selected with hindsight; it is NOT a user win rate.',
            'Rolling windows overlap. Nonoverlapping samples are also provided, but still share one market regime.',
            'Touching a threshold is not the same as remaining above it at expiry.',
            'Extra cost buffers are hypothetical total spread/slippage costs, not measured execution costs.',
        ], 'markets': {},
    }
    summary = []
    for symbol, all_rows in series.items():
        rows = [r for r in all_rows if start <= r['timestamp'] <= end]
        expected = (end - start) // 60000 + 1
        stats = [sample(rows, d, 1, b) for b in [0, 2, 4] for d in [1, 3, 5]]
        nonoverlap = [sample(rows, d, d) for d in [1, 3, 5]]
        report['markets'][symbol] = {'candles': len(rows), 'missing_minutes': expected - len(rows),
            'period_return_pct': (float(rows[-1]['close']) / float(rows[0]['close']) - 1) * 100,
            'rolling': stats, 'nonoverlapping': nonoverlap}
        summary.extend({'symbol': symbol, **s} for s in stats)
    (OUTPUT / 'fee-frequency.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    with (OUTPUT / 'fee-frequency.csv').open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=list(summary[0]))
        writer.writeheader()
        writer.writerows(summary)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
