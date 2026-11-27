# Fee coverage research

Read-only public market analysis, independent of the game and its worker. No
wallet access, credentials, orders, settings changes or simulated user results.

## Historical comparison

Run `python research/fee_frequency.py` from the Up Down folder. Outputs raw
completed one-minute candles and `results/fee-frequency.json` / `.csv`.

The script requests seven days but reports the actual returned interval. The
first study returned only about 67 hours. It compares completed close-to-close
1/3/5-minute windows, with 3 bps charged on each entry and exit notional.
Rising moves are evaluated as longs; falling moves as shorts. The combined
correct-direction percentage thus assumes the direction was known in hindsight,
not that a user or strategy could predict it. Flat moves are excluded from that
conditional denominator. Always-UP, always-DOWN and random-direction rates have
their own explicit denominators. No profit strategy is inferred.

Rolling windows overlap. Nonoverlapping samples and hypothetical extra execution
costs of 2/4 bps are also provided. Candles may use orderbook mid prices in quiet
markets; these results are not a fill simulation. Funding, liquidation, spread,
depth and latency are not modelled by the fee-only comparison. An intrawindow
threshold touch does not imply that a scheduled exit captures it.

## Thirty-second quote collection

Run `node research/record_quotes.mjs --hours 24`. The process stops after 24 wall
clock hours. It subscribes to public SOL/BTC/ETH orderbook snapshots and retains
only timestamp, best bid/ask and sizes. Output is in a unique
`results/quotes-<timestamp>` folder. `status.json` includes PID, stop time, counts
and per-symbol last timestamps; collection gaps are preserved, not interpolated.
The computer must stay awake and connected. It does not survive process termination.
To stop early, interrupt its terminal or stop the PID shown in its status file.

Analyze during or after collection:

    python research/quote_frequency.py research/results/quotes-<timestamp>

This writes `analysis.json` inside that folder. Thirty-second and 1/3/5-minute
samples use nonoverlapping UTC-aligned boundaries and boundary quotes no older
than 2 seconds. Intraround threshold-touch estimates additionally reject gaps
longer than 3 seconds; endpoint returns need only the two boundary quotes.
Coverage and skipped-window counts are reported; exclusions can bias the sample.
Long estimates buy at the ask
and sell at the bid; shorts do the reverse; both subtract entry and exit fees.
This incorporates quoted spread, but not market depth, latency, funding or
liquidation. Quote sizes are recorded for later analysis; no order size is assumed.
Top-of-book estimates are not guaranteed execution prices. A few hours or one
day are preliminary and do not establish a stable future win probability.

## Verify calculations

    python -m unittest discover -s research -p "test_*.py"

References:
- https://orderly.network/docs/build-on-omnichain/public-info-api/market/candles
- https://orderly.network/docs/build-on-omnichain/restful-api/public/get-kline
- https://orderly.network/docs/build-on-omnichain/websocket-api/public/orderbook
