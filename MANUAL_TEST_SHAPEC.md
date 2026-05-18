# Shape-C Backtester — Manual Stress Test

Run these prompts sequentially in the Finny TUI. Each test saves an algorithm
and backtests it. After all tests pass, delete the test algorithms and this
file.

Start the TUI in dev mode:
```
cd packages/opencode && bun run dev
```

**Validator note:** The save validator runs a smoke test on 4 regimes
(constant, up, down, random). Strategies that trade on flat prices
(bar-count triggers, unconditional buys) will fail with
`INVARIANT_CONSTANT_TRADES`. All test strategies below are price-driven
so they pass the smoke test.

---

## Test 1 — Basic Shape-C strategy loads and trades

**Prompt:**
```
Save this algorithm as "test-shapec-basic" with symbol XOM and config {"symbol": "XOM"}:

from collections import deque

class Strategy:
    def __init__(self, broker):
        self.broker = broker
        self.closes = deque(maxlen=20)

    def on_bar(self, symbol, bar):
        self.closes.append(bar["close"])
        if len(self.closes) < 10:
            return
        pos = self.broker.position(symbol)
        avg = sum(list(self.closes)[-10:]) / 10
        if bar["open"] > avg and pos == 0:
            equity = self.broker.equity()
            qty = round((equity * 0.5) / bar["open"], 2)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif bar["open"] < avg and pos > 0:
            self.broker.sell(symbol, qty=pos)

Then backtest it for 3 months at 4h interval with $10k capital.
```

**Expected:**
- Algorithm saves without validation errors
- Backtest returns `ok: true` with metrics
- `total_trades` >= 1
- `ending_equity` is a real number (not 0 or NaN)

**What would fail before this fix:**
`Strategy not loadable from strategy.py` or crash importing
`Broker`/`MarketData` from strategy.py.

---

## Test 2 — Params propagation from config

**Prompt:**
```
Save this as "test-shapec-params" with symbol AAPL and config
{"symbol": "AAPL", "params": {"sma_period": 15, "risk_pct": 0.3}}:

from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.sma_period = p.get("sma_period", 10)
        self.risk_pct = p.get("risk_pct", 0.5)
        self.closes = deque(maxlen=self.sma_period + 5)

    def on_bar(self, symbol, bar):
        self.closes.append(bar["close"])
        if len(self.closes) < self.sma_period:
            return
        pos = self.broker.position(symbol)
        avg = sum(list(self.closes)[-self.sma_period:]) / self.sma_period
        if bar["open"] > avg * 1.01 and pos == 0:
            equity = self.broker.equity()
            qty = round((equity * self.risk_pct) / bar["open"], 2)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif bar["open"] < avg * 0.99 and pos > 0:
            self.broker.sell(symbol, qty=pos)

Then backtest it for 1 month at 1h interval with $10k.
```

**Expected:**
- Saves cleanly (config keys `sma_period` and `risk_pct` used in code)
- Backtest uses 15-bar SMA and 30% risk (from params), not defaults
- `total_trades` >= 1

---

## Test 3 — Strategy with no params kwarg

**Prompt:**
```
Save this as "test-shapec-no-params" with symbol TSLA and config {"symbol": "TSLA"}:

from collections import deque

class Strategy:
    def __init__(self, broker):
        self.broker = broker
        self.closes = deque(maxlen=30)

    def on_bar(self, symbol, bar):
        self.closes.append(bar["close"])
        if len(self.closes) < 20:
            return
        pos = self.broker.position(symbol)
        avg = sum(list(self.closes)[-20:]) / 20
        if bar["open"] > avg and pos == 0:
            equity = self.broker.equity()
            qty = round((equity * 0.4) / bar["open"], 2)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif bar["open"] < avg and pos > 0:
            self.broker.sell(symbol)

Then backtest for 2 weeks at 1d interval with $50k capital.
```

**Expected:**
- Loads successfully even without `params=None` in constructor
- `total_trades` >= 1

---

## Test 4 — Zero-trade strategy (no crash)

**Prompt:**
```
Save this as "test-shapec-noop" with symbol SPY and config {"symbol": "SPY"}:

class Strategy:
    def __init__(self, broker):
        self.broker = broker

    def on_bar(self, symbol, bar):
        pass

Then backtest for 1 month at 1d interval with $10k.
```

**Expected:**
- `ok: true`, no crash
- `total_trades` = 0
- `ending_equity` = 10000

---

## Test 5 — Crypto symbol normalization

**Prompt:**
```
Save this as "test-shapec-crypto" with symbol BTC/USD and config {"symbol": "BTC/USD"}:

from collections import deque

class Strategy:
    def __init__(self, broker):
        self.broker = broker
        self.closes = deque(maxlen=30)

    def on_bar(self, symbol, bar):
        self.closes.append(bar["close"])
        if len(self.closes) < 15:
            return
        pos = self.broker.position(symbol)
        avg = sum(list(self.closes)[-15:]) / 15
        if bar["open"] > avg * 1.02 and pos == 0:
            equity = self.broker.equity()
            px = bar["open"]
            qty = round((equity * 0.3) / px, 8)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif bar["open"] < avg * 0.98 and pos > 0:
            self.broker.sell(symbol)

Then backtest for 1 month at 4h with $10k.
```

**Expected:**
- Symbol normalizes correctly (BTC/USD → yfinance BTC-USD)
- Backtest runs and returns metrics

---

## Test 6 — Full mean-reversion with z-score

**Prompt:**
```
Save this as "test-shapec-meanrev" with symbol XOM and config
{"symbol": "XOM", "params": {"zscore_entry": -1.0, "zscore_exit": 0.0}}:

import math
from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.lookback = 20
        self.zscore_entry = p.get("zscore_entry", -1.0)
        self.zscore_exit = p.get("zscore_exit", 0.0)
        self.closes = deque(maxlen=self.lookback + 5)
        self.entry_price = None

    def on_bar(self, symbol, bar):
        open_p = bar["open"]
        pos = self.broker.position(symbol)

        if pos > 0 and self.entry_price is not None:
            if len(self.closes) >= self.lookback:
                window = list(self.closes)[-self.lookback:]
                mean = sum(window) / len(window)
                std = math.sqrt(sum((x - mean)**2 for x in window) / (len(window) - 1)) if len(window) > 1 else 0
                if std > 1e-10:
                    z = (open_p - mean) / std
                    if z >= self.zscore_exit or open_p <= self.entry_price * 0.95:
                        self.broker.sell(symbol, qty=pos)
                        self.entry_price = None

        if pos == 0 and len(self.closes) >= self.lookback:
            window = list(self.closes)[-self.lookback:]
            mean = sum(window) / len(window)
            std = math.sqrt(sum((x - mean)**2 for x in window) / (len(window) - 1)) if len(window) > 1 else 0
            if std > 1e-10:
                z = (open_p - mean) / std
                if z <= self.zscore_entry:
                    equity = self.broker.equity()
                    qty = round((equity * 0.5) / open_p, 2)
                    if qty > 0:
                        self.broker.buy(symbol, qty=qty)
                        self.entry_price = open_p

        self.closes.append(bar["close"])

Backtest for 6 months at 1d interval with $10k.
```

**Expected:**
- Complex strategy with indicators loads and runs
- Returns real metrics (Sharpe, drawdown, etc.)

---

## Test 7 — All broker API methods in one bar

**Prompt:**
```
Save this as "test-shapec-broker-api" with symbol AAPL and config {"symbol": "AAPL"}:

from collections import deque

class Strategy:
    def __init__(self, broker):
        self.broker = broker
        self.closes = deque(maxlen=20)

    def on_bar(self, symbol, bar):
        cash = self.broker.cash()
        equity = self.broker.equity()
        pos = self.broker.position(symbol)
        px = self.broker.price(symbol)
        self.closes.append(bar["close"])
        if len(self.closes) < 10:
            return
        avg = sum(list(self.closes)[-10:]) / 10
        if pos == 0 and bar["open"] > avg and equity > 0:
            qty = round((equity * 0.25) / bar["open"], 2)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif pos > 0 and bar["open"] < avg:
            self.broker.sell(symbol)

Backtest for 3 months at 1h with $10k.
```

**Expected:**
- All broker methods (cash, equity, position, price) called without error

---

## Test 8 — Notional buy (dollar amount instead of qty)

**Prompt:**
```
Save this as "test-shapec-notional" with symbol SPY and config {"symbol": "SPY"}:

from collections import deque

class Strategy:
    def __init__(self, broker):
        self.broker = broker
        self.closes = deque(maxlen=20)
        self.bought = False

    def on_bar(self, symbol, bar):
        self.closes.append(bar["close"])
        if len(self.closes) < 10:
            return
        pos = self.broker.position(symbol)
        avg = sum(list(self.closes)[-10:]) / 10
        if bar["open"] > avg and not self.bought:
            self.broker.buy(symbol, notional=2000.0)
            self.bought = True
        elif bar["open"] < avg and self.bought and pos > 0:
            self.broker.sell(symbol)
            self.bought = False

Backtest for 2 months at 1d with $10k.
```

**Expected:**
- Notional buy creates position worth ~$2000
- Full sell (no args) closes remaining

---

## Test 9 — Rapid-fire buy/sell cycles

**Prompt:**
```
Save this as "test-shapec-rapid" with symbol QQQ and config {"symbol": "QQQ"}:

from collections import deque

class Strategy:
    def __init__(self, broker):
        self.broker = broker
        self.closes = deque(maxlen=10)

    def on_bar(self, symbol, bar):
        self.closes.append(bar["close"])
        if len(self.closes) < 5:
            return
        pos = self.broker.position(symbol)
        avg = sum(list(self.closes)[-5:]) / 5
        if bar["open"] > avg and pos == 0:
            equity = self.broker.equity()
            qty = round((equity * 0.4) / bar["open"], 2)
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
        elif bar["open"] < avg and pos > 0:
            self.broker.sell(symbol)

Backtest for 3 months at 1h with $50k.
```

**Expected:**
- Many trades (short lookback = frequent crossovers)
- `total_trades` should be high (20+)
- No crash from rapid order cycling

---

## Test 10 — Bar dict field validation

**Prompt:**
```
Save this as "test-shapec-barcheck" with symbol AAPL and config {"symbol": "AAPL"}:

class Strategy:
    def __init__(self, broker):
        self.broker = broker
        self.verified = False

    def on_bar(self, symbol, bar):
        if not self.verified:
            required = {"open", "high", "low", "close", "volume", "timestamp", "symbol"}
            missing = required - set(bar.keys())
            if missing:
                raise ValueError(f"Bar missing keys: {missing}")
            if not isinstance(bar["open"], float):
                raise TypeError(f"open not float: {type(bar['open'])}")
            if not isinstance(bar["timestamp"], int):
                raise TypeError(f"timestamp not int: {type(bar['timestamp'])}")
            if bar["high"] < bar["low"]:
                raise ValueError("high < low")
            self.verified = True

Backtest for 1 week at 1d with $10k.
```

**Expected:**
- If bar dict is malformed, the assert crashes with a clear error
- If it passes: `ok: true`, `total_trades` = 0

---

## Cleanup

After all tests pass, delete the test algorithms:
```
Delete these algorithms: test-shapec-basic, test-shapec-params,
test-shapec-no-params, test-shapec-noop, test-shapec-crypto,
test-shapec-meanrev, test-shapec-broker-api, test-shapec-notional,
test-shapec-rapid, test-shapec-barcheck
```

Then delete this file.
