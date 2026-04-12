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
from datetime import datetime, timezone
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
        return "/" in u or u.endswith("-USD") or u.endswith("USD") and len(u) <= 7 and not u.isalpha()

    @staticmethod
    def normalize_symbol(symbol: str) -> str:
        # Alpaca wants "BTCUSD" (no slash) for crypto pairs.
        return symbol.replace("/", "")

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

    def market_is_open(self) -> bool:
        try:
            clock = self._trading.get_clock()
            return bool(clock.is_open)
        except Exception:
            return True  # fail-open for crypto and unknown cases

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


def load_strategy(strategy_path, broker: Broker):
    """
    Load strategy.py and return a callable step(symbol, bar).

    Supports two conventions:
    1. New: class Strategy(broker) with on_bar(symbol, bar), calls broker directly
    2. Legacy: class Strategy() with on_tick(bar) -> string, wrapped by StrategyAdapter
    """
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location("strategy", str(strategy_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    if not hasattr(mod, "Strategy"):
        raise AttributeError("strategy.py has no 'Strategy' class")

    StrategyCls = mod.Strategy

    # Try broker-based constructor first.
    try:
        instance = StrategyCls(broker)
        if hasattr(instance, "on_bar") and callable(getattr(instance, "on_bar")):
            log_err("[finny_broker] using Strategy(broker).on_bar(symbol, bar)")
            return instance.on_bar
        # Broker constructor worked but no on_bar — fall through to adapter.
        adapter = StrategyAdapter(instance, broker)
        log_err(f"[finny_broker] using legacy adapter on Strategy(broker).{adapter.handler_name}")
        return adapter.on_bar
    except TypeError:
        pass

    # Legacy: Strategy() with no args
    instance = StrategyCls()
    adapter = StrategyAdapter(instance, broker)
    log_err(f"[finny_broker] using legacy adapter on Strategy().{adapter.handler_name}")
    return adapter.on_bar
`
