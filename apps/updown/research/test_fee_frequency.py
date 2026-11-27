import unittest
from fee_frequency import sample
from quote_frequency import analyze


class CostStudyTests(unittest.TestCase):
    def test_direction_correct_but_fees_erase_gain(self):
        rows = [{'timestamp': 60000 * i, 'close': str(p), 'high': str(p), 'low': str(p)} for i, p in enumerate([100, 100.02])]
        result = sample(rows, 1)
        self.assertEqual(result['correct_direction_covers_cost_pct'], 0)
        rows[1]['close'] = rows[1]['high'] = '100.1'
        self.assertEqual(sample(rows, 1)['correct_direction_covers_cost_pct'], 100)

    def test_touch_is_not_profit_at_exit(self):
        rows = [{'timestamp': 0, 'close': '100', 'high': '100', 'low': '100'},
                {'timestamp': 60000, 'close': '100.01', 'high': '100.1', 'low': '100'}]
        result = sample(rows, 1)
        self.assertEqual(result['either_direction_touched_cost_barrier_pct'], 100)
        self.assertEqual(result['correct_direction_covers_cost_pct'], 0)

    def test_candle_gaps_not_treated_as_shorter_horizon(self):
        rows = [{'timestamp': 0, 'close': '100', 'high': '100', 'low': '100'},
                {'timestamp': 120000, 'close': '101', 'high': '101', 'low': '101'}]
        self.assertEqual(sample(rows, 1)['windows'], 0)

    def test_top_of_book_includes_spread_and_fees(self):
        rows = [{'ts': 30000 + i * 1000, 'bid': 99.99 + i * .003, 'ask': 100.01 + i * .003} for i in range(31)]
        self.assertEqual(analyze(rows, 30)['correct_mid_direction_net_positive_pct'], 100)
        for r in rows:
            r['ask'] += .02
        self.assertEqual(analyze(rows, 30)['correct_mid_direction_net_positive_pct'], 0)

    def test_missing_intraround_quotes_do_not_discard_valid_endpoint_returns(self):
        rows = [{'ts': i * 1000, 'bid': 100, 'ask': 100.01} for i in range(30, 61) if i < 40 or i > 50]
        result = analyze(rows, 30)
        self.assertEqual(result['windows'], 1)
        self.assertEqual(result['windows_with_complete_intraround_coverage'], 0)
        self.assertIsNone(result['either_direction_touched_positive_net_pct'])

    def test_stale_boundary_quote_is_excluded(self):
        rows = [{'ts': i * 1000, 'bid': 100, 'ask': 100.01} for i in [30, 31, 56, 61]]
        result = analyze(rows, 30)
        self.assertEqual(result['windows'], 0)
        self.assertEqual(result['skipped_windows_with_gaps'], 1)


if __name__ == '__main__':
    unittest.main()
