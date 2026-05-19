"""
REPLACE-ME strategy v01.

Shape-C strategy contract
=========================

Constructor:
    __init__(self, broker, params=None)

    ``broker`` is the Shape-C broker adapter. ``params`` is an optional dict
    from config.json["params"] — use it for tunable hyperparameters.

Callback:
    on_bar(self, symbol: str, bar: dict) -> None

    Called once per bar in chronological order. ``bar`` keys:
        open, high, low, close, volume  (float)
        timestamp                       (int, unix nanoseconds)
        symbol                          (str)

Broker API:
    broker.buy(symbol, qty=None, notional=None)
    broker.sell(symbol, qty=None, notional=None)
    broker.position(symbol) -> float   # signed qty (0 if flat)
    broker.cash()           -> float
    broker.equity()         -> float   # cash + mark-to-market
    broker.price(symbol)    -> float   # last close

    buy/sell with no qty/notional: buy uses all cash, sell closes position.

Fill semantics:
    Orders fill on the NEXT bar (next-bar fill). Calling buy() then
    immediately checking position() in the same on_bar returns 0.

Lookahead rule:
    Only bar["open"] is decision-time-safe for the current bar. High, low,
    and close are end-of-bar values — using them for entry/exit decisions is
    lookahead bias. Compute indicators from historical closes (previous bars),
    not the current bar's close.

Entry:
  - ...

Exit:
  - ...

Risk:
  - ...
"""


class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.params = params or {}

    def on_bar(self, symbol: str, bar: dict) -> None:
        pass
