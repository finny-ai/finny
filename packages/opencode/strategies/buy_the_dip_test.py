import unittest
from strategies.buy_the_dip import Strategy

class TestBuyTheDip(unittest.TestCase):
    def setUp(self):
        self.strategy = Strategy()

    def test_hold_with_insufficient_data(self):
        bar = {"open": 100, "high": 105, "low": 95, "close": 100, "volume": 10, "timestamp": 123456}
        action = self.strategy.on_tick(bar)
        self.assertEqual(action, "HOLD")

    def test_buy_signal_on_dip(self):
        for price in [100, 101, 99]:
            bar = {"open": price, "high": price, "low": price, "close": price, "volume": 10, "timestamp": 123456}
            action = self.strategy.on_tick(bar)
        self.assertEqual(action, "BUY")

    def test_sell_signal_on_rebound(self):
        for price in [100, 101, 99]:
            bar = {"open": price, "high": price, "low": price, "close": price, "volume": 10, "timestamp": 123456}
            self.strategy.on_tick(bar)
        bar = {"open": 101, "high": 105, "low": 101, "close": 101, "volume": 10, "timestamp": 123456}
        action = self.strategy.on_tick(bar)
        self.assertEqual(action, "SELL")

if __name__ == "__main__":
    unittest.main()
