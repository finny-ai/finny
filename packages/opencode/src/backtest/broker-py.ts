// Shared Python broker source used by both the backtest runner (SimBroker)
// and the live runner (AlpacaBroker). Strategies only see the common `Broker`
// interface so the same code runs against simulated and real brokers.
export const FINNY_BROKER_PY = String.raw`"""
finny_broker — unified broker abstraction for Finny strategies.

A Strategy class should follow this interface:

    class Strategy:
        def __init__(self, broker):
            self.broker = broker

        def on_bar(self, symbol, bar):
            # bar: dict with timestamp/open/high/low/close/volume/symbol
            # call self.broker.buy(symbol, qty=N) / .sell(symbol, qty=N)
            pass

Legacy classes that implement on_tick(bar) -> "BUY"/"SELL"/"HOLD" (or similar
method names) are also supported via StrategyAdapter. Buys use all available
cash; sells close the full position.
"""

from __future__ import annotations
import json
import sys
import traceback
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any


def emit(obj: Dict[str, Any]) -> None:
    """Emit a JSON line to stdout for the parent process to parse."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log_err(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


class OrderRecord:
    __slots__ = ("order_id", "symbol", "side", "qty", "price", "status", "ts")

    def __init__(self, order_id, symbol, side, qty, price, status, ts):
        self.order_id = order_id
        self.symbol = symbol
        self.side = side
        self.qty = qty
        self.price = price
        self.status = status
        self.ts = ts

    def to_dict(self) -> Dict[str, Any]:
        return {
            "order_id": self.order_id,
            "symbol": self.symbol,
            "side": self.side,
            "qty": self.qty,
            "price": self.price,
            "status": self.status,
            "ts": self.ts,
        }


class Broker:
    """Abstract broker interface. Strategies only depend on this."""

    def buy(self, symbol: str, qty: Optional[float] = None, notional: Optional[float] = None) -> OrderRecord:
        raise NotImplementedError

    def sell(self, symbol: str, qty: Optional[float] = None, notional: Optional[float] = None) -> OrderRecord:
        raise NotImplementedError

    def position(self, symbol: str) -> float:
        raise NotImplementedError

    def cash(self) -> float:
        raise NotImplementedError

    def equity(self) -> float:
        raise NotImplementedError

    def price(self, symbol: str) -> Optional[float]:
        raise NotImplementedError

    def fetch_bar(self, symbol: str, interval: str) -> Optional[Dict[str, Any]]:
        """Return the latest bar for the symbol or None if not available.

        Implementations must return a dict with keys
        timestamp/open/high/low/close/volume (all floats except timestamp ISO str).
        """
        raise NotImplementedError

    def market_is_open(self, symbol: str) -> bool:
        """Whether trading the given symbol is allowed right now.

        Default: True (24/7 markets such as crypto). Equity brokers should
        override for stocks while still returning True for their crypto pairs.
        """
        return True

    @staticmethod
    def is_crypto(symbol: str) -> bool:
        u = symbol.upper()
        return "/" in u or "-" in u


class SimBroker(Broker):
    """In-memory simulated broker for backtests."""

    def __init__(self, starting_cash: float, fee_rate: float = 0.00075, slippage: float = 0.0001):
        self._starting_cash = float(starting_cash)
        self._cash = float(starting_cash)
        self._positions: Dict[str, float] = {}
        self._cost_basis: Dict[str, float] = {}
        self._last_price: Dict[str, float] = {}
        self._fee_rate = float(fee_rate)
        self._slippage = float(slippage)
        self._orders: list = []
        self._trade_pnls: list = []
        self._equity_curve: list = [float(starting_cash)]
        self._order_counter = 0

    @property
    def starting_cash(self) -> float:
        return self._starting_cash

    @property
    def equity_curve(self) -> list:
        return list(self._equity_curve)

    @property
    def trade_pnls(self) -> list:
        return list(self._trade_pnls)

    @property
    def orders(self) -> list:
        return [o.to_dict() for o in self._orders]

    def set_price(self, symbol: str, price: float) -> None:
        self._last_price[symbol] = float(price)

    def mark_to_market(self) -> float:
        eq = self._cash
        for sym, qty in self._positions.items():
            eq += qty * self._last_price.get(sym, 0)
        self._equity_curve.append(eq)
        return eq

    def buy(self, symbol, qty=None, notional=None):
        mark = self._last_price.get(symbol)
        if mark is None or mark <= 0:
            return self._reject(symbol, "buy", "no price")
        fill = mark * (1 + self._slippage)
        if notional is not None and qty is None:
            qty = notional / fill
        if qty is None:
            # Default: use all available cash
            qty = self._cash / (fill * (1 + self._fee_rate))
        if qty <= 0:
            return self._reject(symbol, "buy", "invalid qty")
        cost = qty * fill * (1 + self._fee_rate)
        if cost > self._cash:
            qty = self._cash / (fill * (1 + self._fee_rate))
            if qty <= 0:
                return self._reject(symbol, "buy", "insufficient cash")
            cost = qty * fill * (1 + self._fee_rate)

        prev_qty = self._positions.get(symbol, 0)
        prev_basis = self._cost_basis.get(symbol, 0)
        new_qty = prev_qty + qty
        new_basis = (prev_basis * prev_qty + fill * qty) / new_qty if new_qty > 0 else 0

        self._positions[symbol] = new_qty
        self._cost_basis[symbol] = new_basis
        self._cash -= cost
        return self._record(symbol, "buy", qty, fill, "filled")

    def sell(self, symbol, qty=None, notional=None):
        mark = self._last_price.get(symbol)
        if mark is None or mark <= 0:
            return self._reject(symbol, "sell", "no price")
        fill = mark * (1 - self._slippage)
        current = self._positions.get(symbol, 0)
        if current <= 0:
            return self._reject(symbol, "sell", "no position")
        if qty is None and notional is None:
            qty = current
        elif notional is not None:
            qty = notional / fill
        qty = min(qty, current)
        if qty <= 0:
            return self._reject(symbol, "sell", "invalid qty")

        proceeds = qty * fill * (1 - self._fee_rate)
        basis = self._cost_basis.get(symbol, fill) * qty
        pnl = proceeds - basis
        self._trade_pnls.append(pnl)

        new_qty = current - qty
        self._positions[symbol] = new_qty
        if new_qty == 0:
            self._cost_basis.pop(symbol, None)
        self._cash += proceeds
        return self._record(symbol, "sell", qty, fill, "filled")

    def position(self, symbol):
        return self._positions.get(symbol, 0)

    def cash(self):
        return self._cash

    def equity(self):
        return self._equity_curve[-1] if self._equity_curve else self._cash

    def price(self, symbol):
        return self._last_price.get(symbol)

    def _record(self, symbol, side, qty, price, status):
        self._order_counter += 1
        order = OrderRecord(
            order_id=f"sim-{self._order_counter}",
            symbol=symbol,
            side=side,
            qty=qty,
            price=price,
            status=status,
            ts=datetime.now(timezone.utc).isoformat(),
        )
        self._orders.append(order)
        return order

    def _reject(self, symbol, side, reason):
        self._order_counter += 1
        order = OrderRecord(
            order_id=f"sim-{self._order_counter}",
            symbol=symbol,
            side=side,
            qty=0,
            price=0,
            status=f"rejected: {reason}",
            ts=datetime.now(timezone.utc).isoformat(),
        )
        self._orders.append(order)
        return order


class AlpacaBroker(Broker):
    """Live broker backed by alpaca-py. Used by the live runner."""

    def __init__(self, key_id: str, secret: str, paper: bool = True):
        try:
            from alpaca.trading.client import TradingClient
            from alpaca.data.historical import StockHistoricalDataClient, CryptoHistoricalDataClient
        except ImportError as e:
            raise RuntimeError(
                f"alpaca-py import failed ({e}). The managed Python env may be missing "
                f"a transitive dep. Try resetting it from Settings → Paper Trading."
            ) from e

        self._trading = TradingClient(api_key=key_id, secret_key=secret, paper=paper)
        self._stock_data = StockHistoricalDataClient(api_key=key_id, secret_key=secret)
        self._crypto_data = CryptoHistoricalDataClient()
        self._last_price: Dict[str, float] = {}

    @staticmethod
    def is_crypto(symbol: str) -> bool:
        u = symbol.upper()
        if "/" in u or "-" in u:
            return True
        # Bare-ticker heuristic: pairs like BTCUSD or ETHUSDT.
        for quote in ("USDT", "USDC", "USD"):
            if u.endswith(quote) and len(u) > len(quote):
                return True
        return False

    @staticmethod
    def normalize_symbol(symbol: str) -> str:
        # Alpaca's crypto Data API requires the slashed format "BTC/USD".
        # Equities are bare tickers ("AAPL").
        u = symbol.upper().replace("-", "/")
        if not AlpacaBroker.is_crypto(u):
            return u
        if "/" in u:
            return u
        for q in ("USDT", "USDC", "USD"):
            if u.endswith(q) and len(u) > len(q):
                return f"{u[:-len(q)]}/{q}"
        return u

    def market_is_open(self, symbol: str) -> bool:
        # Crypto trades 24/7 on Alpaca.
        if AlpacaBroker.is_crypto(symbol):
            return True
        try:
            clock = self._trading.get_clock()
            return bool(clock.is_open)
        except Exception:
            # Fail open: don't block the loop on a transient clock-endpoint error.
            return True

    def fetch_bar(self, symbol: str, interval: str) -> Optional[Dict[str, Any]]:
        try:
            from alpaca.data.requests import StockBarsRequest, CryptoBarsRequest
            from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
        except ImportError as e:
            log_err(f"alpaca-py missing for fetch_bar: {e}")
            return None

        tf_map = {
            "1min": TimeFrame.Minute,
            "5min": TimeFrame(5, TimeFrameUnit.Minute),
            "15min": TimeFrame(15, TimeFrameUnit.Minute),
            "30min": TimeFrame(30, TimeFrameUnit.Minute),
            "1h": TimeFrame.Hour,
            "4h": TimeFrame(4, TimeFrameUnit.Hour),
            "1d": TimeFrame.Day,
        }
        tf = tf_map.get(interval, TimeFrame.Minute)

        lookback = {
            "1min": timedelta(minutes=15),
            "5min": timedelta(hours=1),
            "15min": timedelta(hours=3),
            "30min": timedelta(hours=6),
            "1h": timedelta(hours=24),
            "4h": timedelta(days=4),
            "1d": timedelta(days=30),
        }.get(interval, timedelta(minutes=15))

        start = datetime.now(timezone.utc) - lookback
        is_crypto = AlpacaBroker.is_crypto(symbol)
        norm = AlpacaBroker.normalize_symbol(symbol)

        try:
            if is_crypto:
                req = CryptoBarsRequest(symbol_or_symbols=norm, timeframe=tf, start=start)
                resp = self._crypto_data.get_crypto_bars(req)
            else:
                req = StockBarsRequest(symbol_or_symbols=norm, timeframe=tf, start=start)
                resp = self._stock_data.get_stock_bars(req)
        except Exception as e:
            log_err(f"Fetch bar error: {e}")
            return None

        bars = resp.data.get(norm, []) if hasattr(resp, "data") else []
        if not bars:
            return None
        latest = bars[-1]
        return {
            "timestamp": latest.timestamp.isoformat(),
            "open": float(latest.open),
            "high": float(latest.high),
            "low": float(latest.low),
            "close": float(latest.close),
            "volume": float(latest.volume),
        }

    def set_price(self, symbol: str, price: float) -> None:
        self._last_price[symbol] = float(price)

    def buy(self, symbol, qty=None, notional=None):
        return self._submit(symbol, "buy", qty, notional)

    def sell(self, symbol, qty=None, notional=None):
        # Default sell = close full position.
        if qty is None and notional is None:
            try:
                pos = self._trading.get_open_position(self.normalize_symbol(symbol))
                qty = float(pos.qty)
            except Exception:
                return self._reject(symbol, "sell", "no open position")
        return self._submit(symbol, "sell", qty, notional)

    def _submit(self, symbol, side, qty, notional):
        try:
            from alpaca.trading.requests import MarketOrderRequest
            from alpaca.trading.enums import OrderSide, TimeInForce
        except ImportError as e:
            return self._reject(symbol, side, f"alpaca-py missing: {e}")

        is_crypto = self.is_crypto(symbol)
        req_kwargs: Dict[str, Any] = {
            "symbol": self.normalize_symbol(symbol),
            "side": OrderSide.BUY if side == "buy" else OrderSide.SELL,
            "time_in_force": TimeInForce.GTC if is_crypto else TimeInForce.DAY,
        }
        if qty is not None:
            req_kwargs["qty"] = qty
        elif notional is not None:
            req_kwargs["notional"] = notional
        else:
            return self._reject(symbol, side, "must specify qty or notional")

        try:
            order = self._trading.submit_order(MarketOrderRequest(**req_kwargs))
            filled_price = float(order.filled_avg_price or 0) or self._last_price.get(symbol, 0)
            return OrderRecord(
                order_id=str(order.id),
                symbol=symbol,
                side=side,
                qty=float(order.qty or qty or 0),
                price=filled_price,
                status=str(order.status),
                ts=datetime.now(timezone.utc).isoformat(),
            )
        except Exception as e:
            return self._reject(symbol, side, str(e))

    def position(self, symbol):
        try:
            pos = self._trading.get_open_position(self.normalize_symbol(symbol))
            return float(pos.qty)
        except Exception:
            return 0

    def cash(self):
        acct = self._trading.get_account()
        return float(acct.cash)

    def equity(self):
        acct = self._trading.get_account()
        return float(acct.portfolio_value)

    def price(self, symbol):
        return self._last_price.get(symbol)

    def _reject(self, symbol, side, reason):
        return OrderRecord(
            order_id="rejected",
            symbol=symbol,
            side=side,
            qty=0,
            price=0,
            status=f"rejected: {reason}",
            ts=datetime.now(timezone.utc).isoformat(),
        )


class BinanceBroker(Broker):
    """Live broker backed by ccxt for Binance spot. Used by the live runner."""

    KNOWN_QUOTES = ("USDT", "USDC", "BUSD", "USD", "BTC", "ETH")

    def __init__(self, api_key: str, secret: str, testnet: bool = True):
        try:
            import ccxt  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"ccxt import failed ({e}). The managed Python env may be missing "
                f"a transitive dep. Try resetting it from Settings → Paper Trading."
            ) from e

        self._ccxt = ccxt
        self._exchange = ccxt.binance({
            "apiKey": api_key,
            "secret": secret,
            "enableRateLimit": True,
            "options": {"defaultType": "spot"},
        })
        if testnet:
            self._exchange.set_sandbox_mode(True)
        self._last_price: Dict[str, float] = {}

    @staticmethod
    def is_crypto(symbol: str) -> bool:
        return True

    @staticmethod
    def normalize_symbol(symbol: str) -> str:
        u = symbol.upper().replace("-", "/")
        if "/" in u:
            return u
        for q in BinanceBroker.KNOWN_QUOTES:
            if u.endswith(q) and len(u) > len(q):
                return f"{u[:-len(q)]}/{q}"
        return f"{u}/USDT"

    def market_is_open(self, symbol: str) -> bool:
        return True

    def set_price(self, symbol: str, price: float) -> None:
        self._last_price[symbol] = float(price)

    def price(self, symbol: str) -> Optional[float]:
        return self._last_price.get(symbol)

    def buy(self, symbol, qty=None, notional=None):
        return self._submit(symbol, "buy", qty, notional)

    def sell(self, symbol, qty=None, notional=None):
        if qty is None and notional is None:
            qty = self.position(symbol)
            if qty <= 0:
                return self._reject(symbol, "sell", "no open position")
        return self._submit(symbol, "sell", qty, notional)

    def _submit(self, symbol, side, qty, notional):
        norm = BinanceBroker.normalize_symbol(symbol)
        try:
            if qty is None and notional is not None:
                ticker = self._exchange.fetch_ticker(norm)
                px = float(ticker.get("last") or ticker.get("close") or 0)
                if px <= 0:
                    return self._reject(symbol, side, "no price for notional sizing")
                qty = notional / px
            if qty is None:
                return self._reject(symbol, side, "must specify qty or notional")
            order = self._exchange.create_order(norm, "market", side, qty)
            filled_price = float(order.get("average") or order.get("price") or 0) or self._last_price.get(symbol, 0)
            return OrderRecord(
                order_id=str(order.get("id", "")),
                symbol=symbol,
                side=side,
                qty=float(order.get("amount") or qty or 0),
                price=filled_price,
                status=str(order.get("status", "submitted")),
                ts=datetime.now(timezone.utc).isoformat(),
            )
        except Exception as e:
            return self._reject(symbol, side, str(e))

    def position(self, symbol: str) -> float:
        norm = BinanceBroker.normalize_symbol(symbol)
        base = norm.split("/")[0]
        try:
            bal = self._exchange.fetch_balance()
            asset = bal.get(base) or {}
            return float(asset.get("total") or 0)
        except Exception:
            return 0.0

    def cash(self) -> float:
        try:
            bal = self._exchange.fetch_balance()
            usdt = bal.get("USDT") or {}
            return float(usdt.get("free") or 0)
        except Exception:
            return 0.0

    def equity(self) -> float:
        try:
            bal = self._exchange.fetch_balance()
            usdt_total = float((bal.get("USDT") or {}).get("total") or 0)
            position_value = 0.0
            for sym, px in self._last_price.items():
                base = BinanceBroker.normalize_symbol(sym).split("/")[0]
                qty = float((bal.get(base) or {}).get("total") or 0)
                position_value += qty * px
            return usdt_total + position_value
        except Exception:
            return 0.0

    def fetch_bar(self, symbol: str, interval: str) -> Optional[Dict[str, Any]]:
        tf_map = {
            "1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m",
            "1h": "1h", "4h": "4h", "1d": "1d",
        }
        tf = tf_map.get(interval, "1m")
        norm = BinanceBroker.normalize_symbol(symbol)
        try:
            bars = self._exchange.fetch_ohlcv(norm, timeframe=tf, limit=1)
        except Exception as e:
            log_err(f"Binance fetch_bar error: {e}")
            return None
        if not bars:
            return None
        ts, o, h, l, c, v = bars[-1]
        return {
            "timestamp": datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat(),
            "open": float(o),
            "high": float(h),
            "low": float(l),
            "close": float(c),
            "volume": float(v),
        }

    def _reject(self, symbol, side, reason):
        return OrderRecord(
            order_id="rejected",
            symbol=symbol,
            side=side,
            qty=0,
            price=0,
            status=f"rejected: {reason}",
            ts=datetime.now(timezone.utc).isoformat(),
        )


class StrategyAdapter:
    """Wraps a legacy Strategy whose method returns 'BUY'/'SELL'/'HOLD' strings."""

    CANDIDATE_METHODS = ["on_bar", "on_tick", "handle_bar", "next", "process_bar", "step"]

    def __init__(self, wrapped, broker: Broker):
        self.wrapped = wrapped
        self.broker = broker
        self.handler = None
        self.handler_name = None
        for m in self.CANDIDATE_METHODS:
            if hasattr(wrapped, m) and callable(getattr(wrapped, m)):
                self.handler = getattr(wrapped, m)
                self.handler_name = m
                break
        if self.handler is None:
            raise AttributeError(
                "Strategy has none of " + str(self.CANDIDATE_METHODS)
                + ". Available methods: " + str([a for a in dir(wrapped) if not a.startswith("_") and callable(getattr(wrapped, a))])
            )

    def _call(self, symbol, bar):
        try:
            return self.handler(bar)
        except TypeError:
            return self.handler(symbol, bar)

    def on_bar(self, symbol, bar):
        try:
            result = self._call(symbol, bar)
        except Exception as e:
            log_err(f"Strategy.{self.handler_name} raised: {e}")
            return

        signal = None
        if result is None:
            return
        if isinstance(result, str):
            u = result.strip().upper()
            if u in ("BUY", "LONG", "ENTER_LONG"):
                signal = "BUY"
            elif u in ("SELL", "EXIT", "EXIT_LONG", "CLOSE"):
                signal = "SELL"
        elif isinstance(result, dict):
            for k in ("action", "side", "signal"):
                if k in result:
                    v = str(result[k]).upper()
                    if v in ("BUY", "LONG"):
                        signal = "BUY"
                    elif v in ("SELL", "EXIT", "CLOSE"):
                        signal = "SELL"
                    break

        if signal == "BUY":
            self.broker.buy(symbol)
        elif signal == "SELL":
            current = self.broker.position(symbol)
            if current > 0:
                self.broker.sell(symbol, qty=current)


def load_strategy(strategy_path, broker: Broker, params=None):
    """
    Load strategy.py and return a callable step(symbol, bar).

    Supports three conventions:
    1. Sweep-friendly: class Strategy(broker, params=None) — params is a dict from
       config["params"], used by finny_backtest_sweep to vary settings.
    2. Standard:  class Strategy(broker) with on_bar(symbol, bar)
    3. Legacy:    class Strategy() with on_tick(bar) -> string, wrapped by StrategyAdapter
    """
    import importlib.util
    import inspect
    from pathlib import Path

    if params is None:
        params = {}

    spec = importlib.util.spec_from_file_location("strategy", str(strategy_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    if not hasattr(mod, "Strategy"):
        raise AttributeError("strategy.py has no 'Strategy' class")

    StrategyCls = mod.Strategy

    accepts_params = False
    try:
        sig = inspect.signature(StrategyCls.__init__)
        accepts_params = "params" in sig.parameters or any(
            p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
        )
    except (TypeError, ValueError):
        pass

    try:
        if accepts_params:
            instance = StrategyCls(broker, params=params)
        else:
            instance = StrategyCls(broker)
        if hasattr(instance, "on_bar") and callable(getattr(instance, "on_bar")):
            log_err("[finny_broker] using Strategy(broker).on_bar(symbol, bar)")
            return instance.on_bar
        adapter = StrategyAdapter(instance, broker)
        log_err(f"[finny_broker] using legacy adapter on Strategy(broker).{adapter.handler_name}")
        return adapter.on_bar
    except TypeError:
        pass

    instance = StrategyCls()
    adapter = StrategyAdapter(instance, broker)
    log_err(f"[finny_broker] using legacy adapter on Strategy().{adapter.handler_name}")
    return adapter.on_bar
`
