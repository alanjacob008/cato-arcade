"""Analyze public quotes recorded by record_quotes.mjs; no trading.

Run: python research/quote_frequency.py research/results/quotes-<timestamp>
Uses nonoverlapping windows aligned to UTC for each duration. Quotes at
each boundary must be no older than 2 seconds. Intrawindow touch metrics
additionally require no >3-second gaps; endpoint returns do not.
Returns use crossing bid/ask plus fees, but ignore depth, latency, funding
and liquidation. A quote is not a guaranteed executable fill.
"""
import bisect
import json
import sys
from pathlib import Path
from statistics import median

FEE = .0003


def analyze(rows, seconds):
    rows = sorted({r['ts']: r for r in rows}.values(), key=lambda r: r['ts'])
    if not rows:
        return {'duration_seconds': seconds, 'windows': 0}
    times = [r['ts'] for r in rows]
    duration = seconds * 1000
    boundary = ((times[0] + duration - 1) // duration) * duration
    correct = net_positive = touched = touch_valid = valid = skipped = 0
    for start in range(boundary, times[-1] - duration + 1, duration):
        i = bisect.bisect_right(times, start) - 1
        j = bisect.bisect_right(times, start + duration) - 1
        segment = rows[i:j + 1] if i >= 0 else []
        if not segment or start - times[i] > 2000 or start + duration - times[j] > 2000:
            skipped += 1
            continue
        valid += 1
        entry, exit_ = rows[i], rows[j]
        move = (exit_['bid'] + exit_['ask']) - (entry['bid'] + entry['ask'])
        long_net = exit_['bid'] * (1 - FEE) - entry['ask'] * (1 + FEE)
        short_net = entry['bid'] * (1 - FEE) - exit_['ask'] * (1 + FEE)
        if move:
            correct += 1
            net_positive += (long_net > 0 if move > 0 else short_net > 0)
        if not any(b['ts'] - a['ts'] > 3000 for a, b in zip(segment, segment[1:])):
            touch_valid += 1
            touched += any(r['bid'] * (1 - FEE) > entry['ask'] * (1 + FEE) or entry['bid'] * (1 - FEE) > r['ask'] * (1 + FEE) for r in segment)
    return {'duration_seconds': seconds, 'windows': valid, 'skipped_windows_with_gaps': skipped,
            'valid_window_coverage_pct': round(valid / (valid + skipped) * 100, 3) if valid + skipped else None,
            'nonflat_windows': correct,
            'correct_mid_direction_net_positive_pct': round(net_positive / correct * 100, 3) if correct else None,
            'windows_with_complete_intraround_coverage': touch_valid,
            'either_direction_touched_positive_net_pct': round(touched / touch_valid * 100, 3) if touch_valid else None}


def main():
    directory = Path(sys.argv[1])
    groups = {}
    with (directory / 'quotes.jsonl').open(encoding='utf-8') as f:
        for line in f:
            if not line.endswith('\n'):
                continue  # Writer may still be appending the final line.
            row = json.loads(line)
            groups.setdefault(row['symbol'], []).append(row)
    result = {'source': str(directory), 'fee_bps_each_side': 3,
              'limitations': 'Top-of-book estimates include spread and fees, exclude depth/slippage/latency/funding/liquidation. Correct-direction rates use hindsight and are not user win probabilities. Short samples are not representative. Missing quote windows are excluded; check coverage because missingness can bias results.', 'markets': {}}
    for symbol, rows in groups.items():
        result['markets'][symbol] = {'quotes': len(rows), 'first_ts': min(r['ts'] for r in rows), 'last_ts': max(r['ts'] for r in rows),
                                     'median_spread_bps': median((r['ask'] - r['bid']) / ((r['ask'] + r['bid']) / 2) * 10000 for r in rows),
                                     'windows': [analyze(rows, seconds) for seconds in [30, 60, 180, 300]]}
    (directory / 'analysis.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
