// Shared Python broker source used by both the backtest runner (SimBroker)
// and the live runner (AlpacaBroker / BinanceBroker / IBKRBroker). Strategies
// only see the common `Broker` interface so the same code runs against
// simulated and real brokers.
export const FINNY_BROKER_PY = String.raw`"""
finny_broker — unified broker abstraction for Finny strategies.

A Strategy class should follow this interface:

    class Strategy:
        def __init__(self, broker):
            self.broker = broker

        def on_bar(self, symbol, bar):
            # bar: dict with timestamp/open/high/low/close/volume/symbol
            # call self.broker.buy(symbol, qty=N, reason="...", features={...})
            pass

Legacy classes that implement on_tick(bar) -> "BUY"/"SELL"/"HOLD" (or similar
method names) are also supported via StrategyAdapter. Buys use all available
cash; sells close the full position.
"""

from __future__ import annotations
import json
import math
import os
import random
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict, Any, Tuple


def _alpaca_budget_wait():
    """Cross-process fixed-window budget for Alpaca Basic workers."""
    try:
        import fcntl
    except ImportError:
        return
    limit = min(160, max(1, int(os.environ.get("FINNY_ALPACA_RPM_BUDGET", "160"))))
    default_budget_root = os.environ.get("FINNY_HOME", "/tmp/finny")
    budget_file = os.environ.get(
        "FINNY_ALPACA_BUDGET_FILE",
        os.path.join(default_budget_root, "alpaca-basic-rate.json"),
    )
    os.makedirs(os.path.dirname(os.path.abspath(budget_file)), mode=0o700, exist_ok=True)
    while True:
        now = time.time()
        flags = os.O_RDWR | os.O_CREAT
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(budget_file, flags, 0o600)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "r+", encoding="utf-8") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handle.seek(0)
            try:
                timestamps = [float(item) for item in json.load(handle)]
            except Exception:
                timestamps = []
            timestamps = [item for item in timestamps if now - item < 60.0]
            if len(timestamps) < limit:
                timestamps.append(now)
                handle.seek(0)
                handle.truncate()
                json.dump(timestamps, handle)
                handle.flush()
                os.fsync(handle.fileno())
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                return
            wait_for = max(0.05, 60.0 - (now - timestamps[0]))
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        time.sleep(wait_for)


def emit(obj: Dict[str, Any]) -> None:
    """Emit a JSON line to stdout for the parent process to parse."""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log_err(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


_INTERVAL_SECONDS = {
    "1min": 60, "5min": 300, "15min": 900, "30min": 1800,
    "1h": 3600, "4h": 14400, "1d": 86400,
}


def finalized_bar_contract(timestamp, interval: str, *, session_id: Optional[str] = None) -> Dict[str, Any]:
    """Conservative provider boundary: a bar is final only after its end time.

    Provider timestamps are treated as bar starts. Unknown intervals never
    become final, which keeps paper execution fail-closed.
    """
    if isinstance(timestamp, datetime):
        start = timestamp
    else:
        try:
            start = datetime.fromisoformat(str(timestamp).replace("Z", "+00:00"))
        except ValueError:
            return {
                "bar_start": str(timestamp), "bar_end": str(timestamp), "is_final": False,
                "session_id": session_id or "unknown", "source_timestamp": datetime.now(timezone.utc).isoformat(),
            }
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    else:
        start = start.astimezone(timezone.utc)
    seconds = _INTERVAL_SECONDS.get(interval)
    end = start + timedelta(seconds=seconds or 0)
    observed = datetime.now(timezone.utc)
    return {
        "bar_start": start.isoformat(),
        "bar_end": end.isoformat(),
        "is_final": seconds is not None and observed >= end,
        "session_id": session_id or start.date().isoformat(),
        "source_timestamp": observed.isoformat(),
    }


def newest_finalized_bar(candidates, interval: str, timestamp_of):
    """Select the newest closed candle even when the provider returns an open tail."""
    for candidate in reversed(list(candidates)):
        finality = finalized_bar_contract(timestamp_of(candidate), interval)
        if finality["is_final"]:
            return candidate, finality
    return None, None


class OrderRecord:
    __slots__ = ("order_id", "symbol", "side", "qty", "price", "status", "ts", "reason", "features")

    def __init__(self, order_id, symbol, side, qty, price, status, ts, reason=None, features=None):
        self.order_id = order_id
        self.symbol = symbol
        self.side = side
        self.qty = qty
        self.price = price
        self.status = status
        self.ts = ts
        self.reason = reason
        self.features = features

    def to_dict(self) -> Dict[str, Any]:
        data = {
            "order_id": self.order_id,
            "symbol": self.symbol,
            "side": self.side,
            "qty": self.qty,
            "price": self.price,
            "status": self.status,
            "ts": self.ts,
        }
        if self.reason is not None:
            data["reason"] = self.reason
        if self.features is not None:
            data["features"] = self.features
        return data


class Broker:
    """Abstract broker interface. Strategies only depend on this."""

    def buy(self, symbol: str, qty: Optional[float] = None, notional: Optional[float] = None, reason: Optional[str] = None, features: Optional[Dict[str, Any]] = None) -> OrderRecord:
        raise NotImplementedError

    def sell(self, symbol: str, qty: Optional[float] = None, notional: Optional[float] = None, reason: Optional[str] = None, features: Optional[Dict[str, Any]] = None) -> OrderRecord:
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

    def execution_snapshot(self, symbol: str) -> Dict[str, Any]:
        """Strict account snapshot for the execution gateway.

        Live adapters override this to avoid legacy display fallbacks that
        translate transport failures into zero balances or flat positions.
        """
        qty = self.position(symbol)
        mark = self.price(symbol)
        if qty != 0 and (mark is None or float(mark) <= 0):
            raise RuntimeError("execution snapshot cannot value the open position")
        positions = {symbol: {"qty": qty, "mark": float(mark)}} if qty != 0 else {}
        return {"cash": self.cash(), "equity": self.equity(), "positions": positions}

    def market_is_open(self, symbol: str) -> bool:
        """Whether trading the given symbol is allowed right now.

        Default: True (24/7 markets such as crypto). Equity brokers should
        override for stocks while still returning True for their crypto pairs.
        """
        return True

    def greeks(self, symbol: str) -> Dict[str, Any]:
        return {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "iv": 0.0}

    def underlying_price(self, symbol: str) -> Optional[float]:
        return None

    def days_to_expiry(self, symbol: str) -> float:
        return float("inf")

    def option_chain(self, underlying: str, expiry: str = None):
        return []

    @staticmethod
    def is_crypto(symbol: str) -> bool:
        u = symbol.upper()
        return "/" in u or "-" in u


class SimBroker(Broker):
    """In-memory simulated broker for backtests.

    Execution model: buy()/sell() ENQUEUE intents. Orders fill at the NEXT
    bar's open via settle(), which the runner calls at the start of each bar
    before invoking the strategy. This eliminates the same-bar-close lookahead
    that lets strategies decide using the price they're about to fill at.

    The first bar of a run produces no fills (no prior intents to settle).
    Intents queued on the last bar of a run remain pending and surface in
    diagnostics['pending_orders_at_end'].
    """

    def __init__(self, starting_cash: float, fee_rate: float = 0.00075, slippage: float = 0.0001):
        self._starting_cash = float(starting_cash)
        self._cash = float(starting_cash)
        self._positions: Dict[str, float] = {}
        self._cost_basis: Dict[str, float] = {}
        self._last_price: Dict[str, float] = {}
        self._fee_rate = float(fee_rate)
        self._slippage = float(slippage)
        self._orders: list = []
        self._pending_orders: list = []  # queued intents awaiting settle()
        self._trade_pnls: list = []
        self._trades: list = []
        self._equity_curve: list = [float(starting_cash)]
        self._position_history: list = []
        self._order_counter = 0
        self._current_ts: Optional[str] = None
        self._reject_log_count = 0
        # Participation tracking — set by the runner before each settle() so
        # we can warn when a single fill exceeds a fraction of bar volume.
        self._bar_volume: Dict[str, float] = {}
        self._participation_warnings: list = []
        # Optional kill switch — when set, drops further fills once equity
        # falls below starting_cash * (1 - killswitch_drawdown).
        self._killswitch_drawdown: Optional[float] = None
        self._killed: Optional[Dict[str, Any]] = None

    def set_killswitch(self, drawdown_frac: Optional[float]) -> None:
        self._killswitch_drawdown = float(drawdown_frac) if drawdown_frac is not None else None

    def set_bar_volume(self, symbol: str, volume: float) -> None:
        self._bar_volume[symbol] = float(volume)

    def set_time(self, ts) -> None:
        self._current_ts = str(ts) if ts is not None else None

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
    def trades(self) -> list:
        return list(self._trades)

    @property
    def orders(self) -> list:
        return [o.to_dict() for o in self._orders]

    def set_price(self, symbol: str, price: float) -> None:
        self._last_price[symbol] = float(price)

    @property
    def position_history(self) -> list:
        return list(self._position_history)

    @property
    def pending_orders(self) -> list:
        return list(self._pending_orders)

    @property
    def killed(self) -> Optional[Dict[str, Any]]:
        return dict(self._killed) if self._killed else None

    def mark_to_market(self) -> float:
        eq = self._cash
        total_pos = 0.0
        for sym, qty in self._positions.items():
            eq += qty * self._last_price.get(sym, 0)
            total_pos += abs(qty)
        self._equity_curve.append(eq)
        self._position_history.append(total_pos)
        # Kill switch — checked after the latest mark so we trip exactly once
        # the post-mark equity falls below the threshold.
        if self._killswitch_drawdown is not None and self._killed is None:
            threshold = self._starting_cash * (1.0 - self._killswitch_drawdown)
            if eq <= threshold:
                self._killed = {
                    "reason": "drawdown",
                    "equity": eq,
                    "threshold": threshold,
                    "drawdown_frac": self._killswitch_drawdown,
                }
                # Drop any pending orders — strategy is dead.
                for order in self._pending_orders:
                    self._update_pending_order_record(order, 0.0, 0.0, "canceled")
                self._pending_orders.clear()
        return eq

    def settle(self, symbol: str, fill_price: float) -> None:
        """Fill queued buy/sell intents at the given price (next bar's open).

        Called by the runner at the start of each bar. Slippage and fees are
        applied here, not at intent time. After a kill-switch trip the queue
        is emptied and this call is a no-op.
        """
        if self._killed is not None:
            for order in self._pending_orders:
                self._update_pending_order_record(order, 0.0, 0.0, "canceled")
            self._pending_orders.clear()
            return
        if fill_price is None or fill_price <= 0:
            return
        # Record the fill price so later strategy reads of broker.price() see
        # decision-time-safe data, not the previous bar's close.
        self._last_price[symbol] = float(fill_price)
        if not self._pending_orders:
            return
        remaining: list = []
        for order in self._pending_orders:
            if order["symbol"] != symbol:
                remaining.append(order)
                continue
            if order["side"] == "buy":
                self._execute_buy(symbol, order, float(fill_price))
            else:
                self._execute_sell(symbol, order, float(fill_price))
        self._pending_orders = remaining

    def _execute_buy(self, symbol: str, order: Dict[str, Any], mark: float) -> None:
        fill = mark * (1 + self._slippage)
        qty = order.get("qty")
        notional = order.get("notional")
        if notional is not None and qty is None:
            qty = notional / fill
        if qty is None:
            qty = self._cash / (fill * (1 + self._fee_rate))
        if qty <= 0:
            self._reject(symbol, "buy", "invalid qty", reason=order.get("reason"), features=order.get("features"))
            return
        gross = qty * fill
        fee = gross * self._fee_rate
        cost = gross + fee
        if cost > self._cash:
            qty = self._cash / (fill * (1 + self._fee_rate))
            if qty <= 0:
                self._reject(symbol, "buy", "insufficient cash", reason=order.get("reason"), features=order.get("features"))
                return
            gross = qty * fill
            fee = gross * self._fee_rate
            cost = gross + fee
        self._check_participation(symbol, qty)
        prev_qty = self._positions.get(symbol, 0)
        prev_basis = self._cost_basis.get(symbol, 0)
        new_qty = prev_qty + qty
        new_basis = (prev_basis * prev_qty + fill * qty) / new_qty if new_qty > 0 else 0
        self._positions[symbol] = new_qty
        self._cost_basis[symbol] = new_basis
        self._cash -= cost
        self._trades.append({
            "timestamp": self._current_ts,
            "side": "buy",
            "qty": qty,
            "price": fill,
            "fee_usd": fee,
            "pnl": None,
        })
        self._update_pending_order_record(order, qty, fill, "filled")

    def _execute_sell(self, symbol: str, order: Dict[str, Any], mark: float) -> None:
        fill = mark * (1 - self._slippage)
        current = self._positions.get(symbol, 0)
        if current <= 0:
            self._reject(symbol, "sell", "no position", reason=order.get("reason"), features=order.get("features"))
            return
        qty = order.get("qty")
        notional = order.get("notional")
        if qty is None and notional is None:
            qty = current
        elif notional is not None:
            qty = notional / fill
        qty = min(qty, current)
        if qty <= 0:
            self._reject(symbol, "sell", "invalid qty", reason=order.get("reason"), features=order.get("features"))
            return
        self._check_participation(symbol, qty)
        gross = qty * fill
        fee = gross * self._fee_rate
        proceeds = gross - fee
        basis = self._cost_basis.get(symbol, fill) * qty
        pnl = proceeds - basis
        self._trade_pnls.append(pnl)
        new_qty = current - qty
        self._positions[symbol] = new_qty
        if new_qty == 0:
            self._cost_basis.pop(symbol, None)
        self._cash += proceeds
        self._trades.append({
            "timestamp": self._current_ts,
            "side": "sell",
            "qty": qty,
            "price": fill,
            "fee_usd": fee,
            "pnl": pnl,
        })
        self._update_pending_order_record(order, qty, fill, "filled")

    def _check_participation(self, symbol: str, qty: float) -> None:
        # Don't reject — just warn. Preserves PnL while making the liquidity
        # assumption visible to the user.
        bar_vol = self._bar_volume.get(symbol)
        if bar_vol is None or bar_vol <= 0:
            return
        if qty > bar_vol * 0.10:
            self._participation_warnings.append({
                "symbol": symbol,
                "qty": qty,
                "bar_volume": bar_vol,
                "participation_pct": (qty / bar_vol) * 100,
            })

    def _update_pending_order_record(self, order: Dict[str, Any], qty: float, price: float, status: str) -> None:
        rec: OrderRecord = order["record"]
        rec.qty = qty
        rec.price = price
        rec.status = status

    def _enqueue(self, symbol: str, side: str, qty: Optional[float], notional: Optional[float], reason=None, features=None) -> OrderRecord:
        if self._killed is not None:
            return self._reject(symbol, side, f"killed: {self._killed['reason']}", reason=reason, features=features)
        rec = self._record(symbol, side, qty if qty is not None else 0.0, 0.0, "pending", reason=reason, features=features)
        self._pending_orders.append({
            "symbol": symbol,
            "side": side,
            "qty": qty,
            "notional": notional,
            "reason": reason,
            "features": features,
            "record": rec,
        })
        return rec

    def buy(self, symbol, qty=None, notional=None, reason=None, features=None):
        return self._enqueue(symbol, "buy", qty, notional, reason=reason, features=features)

    def sell(self, symbol, qty=None, notional=None, reason=None, features=None):
        return self._enqueue(symbol, "sell", qty, notional, reason=reason, features=features)

    def position(self, symbol):
        return self._positions.get(symbol, 0)

    def cash(self):
        return self._cash

    def equity(self):
        return self._equity_curve[-1] if self._equity_curve else self._cash

    def price(self, symbol):
        return self._last_price.get(symbol)

    def _record(self, symbol, side, qty, price, status, reason=None, features=None):
        self._order_counter += 1
        order = OrderRecord(
            order_id=f"sim-{self._order_counter}",
            symbol=symbol,
            side=side,
            qty=qty,
            price=price,
            status=status,
            ts=self._current_ts or datetime.now(timezone.utc).isoformat(),
            reason=reason,
            features=features,
        )
        self._orders.append(order)
        return order

    def _reject(self, symbol, side, reject_reason, reason=None, features=None):
        self._order_counter += 1
        order = OrderRecord(
            order_id=f"sim-{self._order_counter}",
            symbol=symbol,
            side=side,
            qty=0,
            price=0,
            status=f"rejected: {reject_reason}",
            ts=self._current_ts or datetime.now(timezone.utc).isoformat(),
            reason=reason,
            features=features,
        )
        self._orders.append(order)
        self._reject_log_count += 1
        if self._reject_log_count <= 5:
            log_err(f"[SimBroker] order rejected: {side} {symbol} — {reject_reason}")
            if self._reject_log_count == 5:
                log_err("[SimBroker] further rejection logs suppressed (see diagnostics)")
        return order

    def diagnostics(self) -> Dict[str, Any]:
        filled = [o for o in self._orders if o.status == "filled"]
        rejected = [o for o in self._orders if o.status.startswith("rejected")]
        pending = [o for o in self._orders if o.status == "pending"]
        buy_attempts = sum(1 for o in self._orders if o.side == "buy")
        sell_attempts = sum(1 for o in self._orders if o.side == "sell")
        rejection_reasons: Dict[str, int] = {}
        for o in rejected:
            reason = o.status.replace("rejected: ", "")
            rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1
        # Cap unbounded warning list when serializing — keep the first 20 +
        # a count so a noisy strategy can't blow up the diag payload.
        pw = self._participation_warnings
        pw_serialized = pw[:20] if len(pw) <= 20 else pw[:20] + [{"truncated": len(pw) - 20}]
        return {
            "total_orders": len(self._orders),
            "filled_orders": len(filled),
            "rejected_orders": len(rejected),
            "pending_orders_at_end": len(pending),
            "buy_attempts": buy_attempts,
            "sell_attempts": sell_attempts,
            "rejection_reasons": rejection_reasons,
            "final_cash": self._cash,
            "final_equity": self._equity_curve[-1] if self._equity_curve else self._cash,
            "assumptions": {
                "fee_rate": self._fee_rate,
                "slippage": self._slippage,
                "fill_model": "next_open",
                "participation_cap_pct": 10.0,
            },
            "participation_warnings": pw_serialized,
            "participation_warning_count": len(pw),
            "killed": self.killed,
        }


class ScanBroker(SimBroker):
    """Dry-run broker that counts signals without executing trades."""

    def __init__(self, starting_cash: float):
        super().__init__(starting_cash)
        self.buy_signals = 0
        self.sell_signals = 0

    def buy(self, symbol, qty=None, notional=None, reason=None, features=None):
        self.buy_signals += 1
        return self._record(symbol, "buy", 0, 0, "scan", reason=reason, features=features)

    def sell(self, symbol, qty=None, notional=None, reason=None, features=None):
        self.sell_signals += 1
        return self._record(symbol, "sell", 0, 0, "scan", reason=reason, features=features)


class AlpacaBroker(Broker):
    """Live broker backed by alpaca-py. Used by the live runner."""

    def __init__(self, key_id: str, secret: str, paper: bool = True, endpoint: Optional[str] = None):
        try:
            from alpaca.trading.client import TradingClient
            from alpaca.data.historical import StockHistoricalDataClient, CryptoHistoricalDataClient
        except ImportError as e:
            raise RuntimeError(
                f"alpaca-py import failed ({e}). The managed Python env may be missing "
                f"a transitive dep. Try resetting it from Settings → Brokerages."
            ) from e

        trading_kwargs = {"api_key": key_id, "secret_key": secret, "paper": paper}
        if endpoint:
            trading_kwargs["url_override"] = endpoint.rstrip("/")
        try:
            self._trading = TradingClient(**trading_kwargs)
        except TypeError as e:
            if endpoint:
                raise RuntimeError(
                    "alpaca-py TradingClient does not support the configured endpoint override. "
                    "Upgrade alpaca-py or clear the custom Alpaca endpoint in Settings → Brokerages."
                ) from e
            raise
        self._stock_data = StockHistoricalDataClient(api_key=key_id, secret_key=secret)
        self._crypto_data = CryptoHistoricalDataClient()
        self._last_price: Dict[str, float] = {}
        self._paper = bool(paper)
        self._clock_cache = None
        self._clock_cache_at = 0.0

    def _call(self, operation, *, attempts=5):
        last = None
        for attempt in range(attempts):
            _alpaca_budget_wait()
            try:
                return operation()
            except Exception as exc:
                last = exc
                text = str(exc).lower()
                if "401" in text or "403" in text or "unauthorized" in text or "forbidden" in text:
                    raise
                if attempt + 1 >= attempts:
                    raise
                retry_after = getattr(getattr(exc, "response", None), "headers", {}).get("Retry-After")
                try:
                    delay = float(retry_after)
                except (TypeError, ValueError):
                    delay = min(30.0, 0.5 * (2 ** attempt))
                time.sleep(delay + random.random() * max(0.05, delay * 0.2))
        raise last or RuntimeError("Alpaca request failed")

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
            now = time.time()
            if self._clock_cache is not None and now - self._clock_cache_at < 60.0:
                return bool(self._clock_cache.is_open)
            clock = self._call(lambda: self._trading.get_clock())
            self._clock_cache = clock
            self._clock_cache_at = now
            return bool(clock.is_open)
        except Exception:
            # Execution safety is more important than liveness: an unknown
            # calendar/session state cannot authorize a paper decision.
            return False

    def fetch_bar(self, symbol: str, interval: str) -> Optional[Dict[str, Any]]:
        try:
            from alpaca.data.requests import StockBarsRequest, CryptoBarsRequest
            from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
            from alpaca.data.enums import DataFeed
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
                resp = self._call(lambda: self._crypto_data.get_crypto_bars(req))
            else:
                req = StockBarsRequest(symbol_or_symbols=norm, timeframe=tf, start=start, feed=DataFeed.IEX)
                resp = self._call(lambda: self._stock_data.get_stock_bars(req))
        except Exception as e:
            text = str(e).lower()
            if "401" in text or "403" in text or "unauthorized" in text or "forbidden" in text or "entitlement" in text:
                raise
            log_err(f"Fetch bar error: {e}")
            return None

        bars = resp.data.get(norm, []) if hasattr(resp, "data") else []
        if not bars:
            return None
        latest, finality = newest_finalized_bar(bars, interval, lambda item: item.timestamp)
        if latest is None:
            return None
        return {
            "timestamp": latest.timestamp.isoformat(),
            "open": float(latest.open),
            "high": float(latest.high),
            "low": float(latest.low),
            "close": float(latest.close),
            "volume": float(latest.volume),
            **finality,
        }

    def set_price(self, symbol: str, price: float) -> None:
        self._last_price[symbol] = float(price)

    def buy(self, symbol, qty=None, notional=None, reason=None, features=None, client_order_id=None):
        return self._submit(symbol, "buy", qty, notional, reason=reason, features=features, client_order_id=client_order_id)

    def sell(self, symbol, qty=None, notional=None, reason=None, features=None, client_order_id=None):
        # Default sell = close full position.
        if qty is None and notional is None:
            try:
                pos = self._call(lambda: self._trading.get_open_position(self.normalize_symbol(symbol)))
                qty = float(pos.qty)
            except Exception:
                return self._reject(symbol, "sell", "no open position", reason=reason, features=features)
        return self._submit(symbol, "sell", qty, notional, reason=reason, features=features, client_order_id=client_order_id)

    def _submit(self, symbol, side, qty, notional, reason=None, features=None, client_order_id=None):
        try:
            from alpaca.trading.requests import MarketOrderRequest
            from alpaca.trading.enums import OrderSide, TimeInForce
        except ImportError as e:
            return self._reject(symbol, side, f"alpaca-py missing: {e}", reason=reason, features=features)

        is_crypto = self.is_crypto(symbol)
        req_kwargs: Dict[str, Any] = {
            "symbol": self.normalize_symbol(symbol),
            "side": OrderSide.BUY if side == "buy" else OrderSide.SELL,
            "time_in_force": TimeInForce.GTC if is_crypto else TimeInForce.DAY,
        }
        if client_order_id:
            req_kwargs["client_order_id"] = str(client_order_id)
        if qty is not None:
            req_kwargs["qty"] = qty
        elif notional is not None:
            req_kwargs["notional"] = notional
        else:
            return self._reject(symbol, side, "must specify qty or notional", reason=reason, features=features)

        try:
            order = self._call(lambda: self._trading.submit_order(MarketOrderRequest(**req_kwargs)))
            filled_price = float(order.filled_avg_price or 0) or self._last_price.get(symbol, 0)
            return OrderRecord(
                order_id=str(order.id),
                symbol=symbol,
                side=side,
                qty=float(order.qty or qty or 0),
                price=filled_price,
                status=str(order.status),
                ts=datetime.now(timezone.utc).isoformat(),
                reason=reason,
                features=features,
            )
        except Exception as e:
            return self._reject(symbol, side, str(e), reason=reason, features=features)

    def position(self, symbol):
        try:
            pos = self._call(lambda: self._trading.get_open_position(self.normalize_symbol(symbol)))
            return float(pos.qty)
        except Exception:
            return 0

    def cash(self):
        acct = self._call(lambda: self._trading.get_account())
        return float(acct.cash)

    def equity(self):
        acct = self._call(lambda: self._trading.get_account())
        return float(acct.portfolio_value)

    def execution_snapshot(self, symbol: str) -> Dict[str, Any]:
        acct = self._call(lambda: self._trading.get_account())
        positions = {
            self.normalize_symbol(str(item.symbol)): {"qty": float(item.qty), "mark": float(item.current_price)}
            for item in self._call(lambda: self._trading.get_all_positions())
            if float(item.qty) != 0.0
        }
        return {"cash": float(acct.cash), "equity": float(acct.portfolio_value), "positions": positions}

    def preflight(self, symbol: str, interval: str) -> Dict[str, Any]:
        if not self._paper:
            raise RuntimeError("Alpaca live accounts are rejected by the paper execution contract")
        endpoint = os.environ.get("ALPACA_ENDPOINT", "")
        if endpoint.rstrip("/") != "https://paper-api.alpaca.markets":
            raise RuntimeError("Alpaca endpoint must be the canonical paper endpoint")
        account = self._call(lambda: self._trading.get_account())
        buying_power = float(account.buying_power)
        if not math.isfinite(buying_power) or buying_power <= 0:
            raise RuntimeError("Alpaca paper account has invalid buying power")
        norm = self.normalize_symbol(symbol)
        asset_symbol = norm.replace("/", "")
        asset = self._call(lambda: self._trading.get_asset(asset_symbol))
        if not str(asset.status).lower().endswith("active") or not bool(asset.tradable):
            raise RuntimeError(f"Alpaca asset {asset_symbol} is not active and tradable")
        bar = self.fetch_bar(symbol, interval)
        if bar is None or bar.get("is_final") is not True:
            raise RuntimeError("Alpaca preflight could not obtain a finalized IEX/crypto bar")
        return {"account_id": str(account.id), "buying_power": buying_power, "bar": bar}

    def get_order_by_client_id(self, client_order_id: str):
        try:
            return self._call(lambda: self._trading.get_order_by_client_id(str(client_order_id)), attempts=3)
        except Exception as exc:
            text = str(exc).lower()
            if "404" in text or "not found" in text:
                return None
            raise

    def cancel_all_orders(self):
        return self._call(lambda: self._trading.cancel_orders())

    def close_all_positions(self):
        return self._call(lambda: self._trading.close_all_positions(cancel_orders=True))

    def price(self, symbol):
        return self._last_price.get(symbol)

    def _reject(self, symbol, side, reject_reason, reason=None, features=None):
        return OrderRecord(
            order_id="rejected",
            symbol=symbol,
            side=side,
            qty=0,
            price=0,
            status=f"rejected: {reject_reason}",
            ts=datetime.now(timezone.utc).isoformat(),
            reason=reason,
            features=features,
        )


class BinanceBroker(Broker):
    """Live broker backed by ccxt for Binance spot. Used by the live runner."""

    KNOWN_QUOTES = ("USDT", "USDC", "BUSD", "USD", "BTC", "ETH")

    def __init__(self, api_key: str, secret: str, testnet: bool = True, endpoint: Optional[str] = None):
        try:
            import ccxt  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"ccxt import failed ({e}). The managed Python env may be missing "
                f"a transitive dep. Try resetting it from Settings → Brokerages."
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
        if endpoint:
            self._apply_endpoint(endpoint)
        self._last_price: Dict[str, float] = {}

    def _apply_endpoint(self, endpoint: str) -> None:
        base = endpoint.rstrip("/")
        if base.endswith("/api/v3"):
            spot_base = base
        elif base.endswith("/api"):
            spot_base = f"{base}/v3"
        else:
            spot_base = f"{base}/api/v3"

        api_urls = self._exchange.urls.get("api")
        if isinstance(api_urls, dict):
            api_urls["public"] = spot_base
            api_urls["private"] = spot_base
        else:
            self._exchange.urls["api"] = spot_base

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

    def buy(self, symbol, qty=None, notional=None, reason=None, features=None):
        return self._submit(symbol, "buy", qty, notional, reason=reason, features=features)

    def sell(self, symbol, qty=None, notional=None, reason=None, features=None):
        if qty is None and notional is None:
            qty = self.position(symbol)
            if qty <= 0:
                return self._reject(symbol, "sell", "no open position", reason=reason, features=features)
        return self._submit(symbol, "sell", qty, notional, reason=reason, features=features)

    def _submit(self, symbol, side, qty, notional, reason=None, features=None):
        norm = BinanceBroker.normalize_symbol(symbol)
        try:
            if qty is None and notional is not None:
                ticker = self._exchange.fetch_ticker(norm)
                px = float(ticker.get("last") or ticker.get("close") or 0)
                if px <= 0:
                    return self._reject(symbol, side, "no price for notional sizing", reason=reason, features=features)
                qty = notional / px
            if qty is None:
                return self._reject(symbol, side, "must specify qty or notional", reason=reason, features=features)
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
                reason=reason,
                features=features,
            )
        except Exception as e:
            return self._reject(symbol, side, str(e), reason=reason, features=features)

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

    def execution_snapshot(self, symbol: str) -> Dict[str, Any]:
        balance = self._exchange.fetch_balance()
        quote = balance.get("USDT") or {}
        cash = float(quote.get("free") or 0)
        equity = float(quote.get("total") or 0)
        positions: Dict[str, Dict[str, float]] = {}
        for asset, value in balance.items():
            if asset in {"info", "free", "used", "total", "USDT"} or not isinstance(value, dict):
                continue
            qty = float(value.get("total") or 0)
            if qty == 0:
                continue
            market = f"{asset}/USDT"
            ticker = self._exchange.fetch_ticker(market)
            price = float(ticker.get("last") or ticker.get("close") or 0)
            if price <= 0:
                raise RuntimeError(f"Binance execution snapshot cannot value {market}")
            positions[market] = {"qty": qty, "mark": price}
            equity += qty * price
        return {"cash": cash, "equity": equity, "positions": positions}

    def fetch_bar(self, symbol: str, interval: str) -> Optional[Dict[str, Any]]:
        tf_map = {
            "1min": "1m", "5min": "5m", "15min": "15m", "30min": "30m",
            "1h": "1h", "4h": "4h", "1d": "1d",
        }
        tf = tf_map.get(interval, "1m")
        norm = BinanceBroker.normalize_symbol(symbol)
        try:
            bars = self._exchange.fetch_ohlcv(norm, timeframe=tf, limit=2)
        except Exception as e:
            log_err(f"Binance fetch_bar error: {e}")
            return None
        if not bars:
            return None
        latest, finality = newest_finalized_bar(bars, interval, lambda item: datetime.fromtimestamp(item[0] / 1000, tz=timezone.utc))
        if latest is None:
            return None
        ts, o, h, l, c, v = latest
        timestamp = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        return {
            "timestamp": timestamp.isoformat(),
            "open": float(o),
            "high": float(h),
            "low": float(l),
            "close": float(c),
            "volume": float(v),
            **finality,
        }

    def _reject(self, symbol, side, reject_reason, reason=None, features=None):
        return OrderRecord(
            order_id="rejected",
            symbol=symbol,
            side=side,
            qty=0,
            price=0,
            status=f"rejected: {reject_reason}",
            ts=datetime.now(timezone.utc).isoformat(),
            reason=reason,
            features=features,
        )


class IBKRBroker(Broker):
    """Live broker backed by ib_insync, talking to TWS or IB Gateway on localhost.

    Setup expected from the user (one-time per machine):
      1. Run TWS or IB Gateway, log in (paper or live credentials).
      2. TWS: File → Global Configuration → API → Settings
         IB Gateway: Configure → Settings → API → Settings
         - Enable ActiveX and Socket Clients
         - Socket port = 7497/7496 for TWS or 4002/4001 for IB Gateway
         - Uncheck "Read-Only API"
      3. Keep TWS / IB Gateway open while strategies run. IBKR sessions can
         require periodic re-login in the desktop app - this class will
         attempt automatic reconnects with exponential backoff once IBKR is
         reachable again, so the algo recovers without manual restart.
    """

    # Tags from accountSummary() that we care about. Pulled once per call
    # rather than subscribed because our strategy callbacks are bar-paced.
    _CASH_TAG = "TotalCashValue"
    _EQUITY_TAG = "NetLiquidation"

    # IBKR pacing: max ~60 historical-data requests / 10 min / identifier.
    # At strategy cadence (1 fetch per bar interval) we're nowhere near it.
    _INTERVAL_TO_BARSIZE = {
        "1min":  ("1 min",   "120 S"),
        "5min":  ("5 mins",  "600 S"),
        "15min": ("15 mins", "1800 S"),
        "30min": ("30 mins", "3600 S"),
        "1h":    ("1 hour",  "7200 S"),
        "4h":    ("4 hours", "1 D"),
        "1d":    ("1 day",   "2 D"),
    }

    # Most futures need an explicit exchange — SMART routing is equities-only.
    # Mapping covers the common contracts US retail trades; for anything
    # outside this list the user should switch to a specific contract syntax
    # and the runtime will fail loud with IBKR's "ambiguous contract" error.
    _FUTURES_EXCHANGES = {
        "ES":  "CME",   "MES": "CME",     # S&P 500
        "NQ":  "CME",   "MNQ": "CME",     # NASDAQ-100
        "RTY": "CME",   "M2K": "CME",     # Russell 2000
        "YM":  "CBOT",  "MYM": "CBOT",    # Dow
        "CL":  "NYMEX", "MCL": "NYMEX",   # Crude oil
        "NG":  "NYMEX",                   # Natural gas
        "GC":  "COMEX", "MGC": "COMEX",   # Gold
        "SI":  "COMEX", "SIL": "COMEX",   # Silver
        "HG":  "COMEX",                   # Copper
        "ZB":  "CBOT",  "ZN":  "CBOT",    # Treasury futures
        "ZF":  "CBOT",  "ZT":  "CBOT",
        "ZC":  "CBOT",  "ZS":  "CBOT", "ZW": "CBOT",  # Grains
        "6E":  "CME",   "6J":  "CME",  "6B": "CME",   # Currency futures
        "6A":  "CME",   "6C":  "CME",
        "BTC": "CME",   "MBT": "CME",     # Bitcoin futures
        "ETH": "CME",   "MET": "CME",     # Ether futures
    }

    # Equity options always trade as 100-multiplier contracts on US exchanges
    # we care about. Used for sizing default-cash buys.
    _OPTION_MULTIPLIER = 100

    def __init__(self, account_id: str, host: str = "127.0.0.1", port: int = 7497, client_id: int = 1):
        try:
            # nest_asyncio lets ib_insync's event loop coexist with whatever
            # event loop the surrounding worker may have started (notably
            # Jupyter / pytest-asyncio). Cheap to install; no-op if unused.
            import nest_asyncio  # type: ignore
            nest_asyncio.apply()
        except ImportError:
            pass

        try:
            from ib_insync import IB
        except ImportError as e:
            raise RuntimeError(
                f"ib_insync import failed ({e}). The managed Python env may be missing "
                f"a transitive dep. Try resetting it from Settings → Brokerages."
            ) from e

        self._account = account_id
        self._host = host
        self._port = port
        self._client_id = client_id
        self._ib = IB()

        # Flag flipped during deliberate teardown so the disconnect handler
        # doesn't fight a planned shutdown.
        self._shutting_down = False

        # Symbol -> qualified Contract. Qualification is a round-trip to IBKR,
        # so we cache.
        self._contracts: Dict[str, Any] = {}
        # Symbol -> Ticker subscription. Once subscribed, ticks flow into the
        # Ticker object continuously; we just read .marketPrice() / .last.
        # Re-subscribed after auto-reconnect because IBKR-side subscriptions
        # die with the socket.
        self._tickers: Dict[str, Any] = {}
        self._last_price: Dict[str, float] = {}

        self._connect_or_raise()

        # Surface IBKR-side errors as log lines for visibility. errorEvent
        # signature in ib_insync is (reqId, errorCode, errorString, contract).
        # Codes 2104/2106/2158 are "Market data farm connection is OK" status
        # heartbeats — filter those out so the log isn't noisy.
        def _on_error(reqId, code, message, contract):
            if code in (2104, 2106, 2107, 2108, 2158):
                return
            log_err(f"[IBKRBroker] IBKR error {code}: {message}")
        self._ib.errorEvent += _on_error

        # Auto-reconnect with exponential backoff on socket loss. Capped at
        # 5 attempts so a stuck TWS / IB Gateway doesn't infinite-loop us.
        def _on_disconnected():
            if self._shutting_down:
                return
            log_err("[IBKRBroker] TWS / IB Gateway disconnected - attempting reconnect")
            delay = 1.0
            for attempt in range(1, 6):
                try:
                    # ib.sleep yields the event loop, so backoff doesn't block
                    # the asyncio reactor.
                    self._ib.sleep(delay)
                    self._ib.connect(
                        self._host, self._port,
                        clientId=self._client_id, readonly=False, timeout=10,
                    )
                    log_err(f"[IBKRBroker] reconnected on attempt {attempt}")
                    self._resubscribe_tickers()
                    return
                except Exception as e:
                    log_err(f"[IBKRBroker] reconnect attempt {attempt}/5 failed: {e}")
                    delay *= 2
            log_err("[IBKRBroker] gave up reconnecting after 5 attempts — strategy will fail on next broker call")
        self._ib.disconnectedEvent += _on_disconnected

    def _connect_or_raise(self):
        try:
            self._ib.connect(
                self._host, self._port,
                clientId=self._client_id, readonly=False, timeout=10,
            )
        except Exception as e:
            raise RuntimeError(
                f"Could not connect to TWS / IB Gateway at {self._host}:{self._port} "
                f"(clientId={self._client_id}). Is TWS or IB Gateway running with API enabled? "
                f"Enable socket clients in API Settings and confirm the socket port matches this account. "
                f"Underlying error: {e}"
            ) from e

    def _resubscribe_tickers(self):
        """After a reconnect, the old Ticker objects are dead. Subscribe
        again for every symbol we were watching, preserving the cache."""
        old_symbols = list(self._tickers.keys())
        self._tickers.clear()
        # Contract qualifications also need to refresh (conId is per-session
        # in some cases; safest to re-qualify rather than trust the cache).
        self._contracts.clear()
        for sym in old_symbols:
            try:
                self._ticker(sym)
            except Exception as e:
                log_err(f"[IBKRBroker] failed to re-subscribe {sym}: {e}")

    def close(self):
        """Best-effort clean shutdown. The live runner calls this on exit."""
        self._shutting_down = True
        try:
            self._ib.disconnect()
        except Exception:
            pass

    # --- symbol / contract helpers ---

    # Pattern matches: SPY/20260619/500C or AAPL/20260117/175.5P
    import re as _re
    _OPTION_RE = _re.compile(r"^([A-Z]{1,6})/(\d{8})/(\d+(?:\.\d+)?)([CP])$")
    # Future specific contract: ES/202612
    _FUTURE_RE = _re.compile(r"^([A-Z0-9]{1,5})/(\d{6})$")
    # Continuous front-month future: ES/CONT
    _FUTURE_CONT_RE = _re.compile(r"^([A-Z0-9]{1,5})/CONT$")
    del _re

    @classmethod
    def is_option(cls, symbol: str) -> bool:
        return bool(cls._OPTION_RE.match(symbol.upper()))

    @classmethod
    def is_future(cls, symbol: str) -> bool:
        u = symbol.upper()
        return bool(cls._FUTURE_RE.match(u) or cls._FUTURE_CONT_RE.match(u))

    @classmethod
    def is_crypto(cls, symbol: str) -> bool:
        # A naked '/' could be option or future — discriminate first.
        if cls.is_option(symbol) or cls.is_future(symbol):
            return False
        u = symbol.upper()
        return "." in u or "/" in u

    @classmethod
    def normalize_symbol(cls, symbol: str) -> str:
        u = symbol.upper()
        # Options and futures stay as-is (their slashes are structural).
        # Crypto: accept slash form ("BTC/USD") and normalize to dot form.
        if cls.is_option(u) or cls.is_future(u):
            return u
        return u.replace("/", ".")

    def _futures_exchange(self, symbol_root: str) -> str:
        ex = self._FUTURES_EXCHANGES.get(symbol_root.upper())
        if ex is None:
            raise RuntimeError(
                f"No default exchange known for futures symbol {symbol_root!r}. "
                f"Supported: {', '.join(sorted(self._FUTURES_EXCHANGES))}. "
                f"If you really want to trade this contract, extend "
                f"IBKRBroker._FUTURES_EXCHANGES in broker-py.ts."
            )
        return ex

    def _contract(self, symbol: str):
        """Resolve a canonical symbol to a qualified ib_insync Contract.

        Branches by instrument type — equity, crypto, option, future, continuous
        future. Each path constructs the right ib_insync contract class and
        qualifies it (one round-trip to TWS). Results are cached so repeat calls
        in the same session are free.
        """
        norm = self.normalize_symbol(symbol)
        cached = self._contracts.get(norm)
        if cached is not None:
            return cached

        from ib_insync import Stock, Crypto, Option, Future, ContFuture

        m_opt = self._OPTION_RE.match(norm)
        m_fut = self._FUTURE_RE.match(norm)
        m_fut_cont = self._FUTURE_CONT_RE.match(norm)

        if m_opt:
            underlying, expiry, strike_str, right = m_opt.groups()
            try:
                strike = float(strike_str)
            except ValueError:
                raise RuntimeError(f"Option strike {strike_str!r} is not a number in symbol {symbol!r}")
            # SMART works for US equity options. Multiplier=100 is implicit.
            contract = Option(underlying, expiry, strike, right.upper(), "SMART", currency="USD")
        elif m_fut:
            root, expiry = m_fut.groups()
            exchange = self._futures_exchange(root)
            contract = Future(root, expiry, exchange, currency="USD")
        elif m_fut_cont:
            (root,) = m_fut_cont.groups()
            exchange = self._futures_exchange(root)
            # ContFuture auto-rolls to the front month; ideal for backtest-shaped
            # strategies that don't want to manage contract expiry themselves.
            contract = ContFuture(root, exchange, currency="USD")
        elif self.is_crypto(norm):
            base, _, quote = norm.partition(".")
            if not base or not quote:
                raise RuntimeError(f"Crypto symbol {symbol!r} must be in BASE.QUOTE form (e.g. BTC.USD)")
            contract = Crypto(base, "PAXOS", quote or "USD")
        else:
            contract = Stock(norm, "SMART", "USD")

        qualified = self._ib.qualifyContracts(contract)
        if not qualified or not qualified[0].conId:
            raise RuntimeError(
                f"IBKR could not resolve symbol {symbol!r}. Check spelling, expiry "
                f"(weekly vs monthly), strike, and that your TWS subscription "
                f"covers this market."
            )
        self._contracts[norm] = qualified[0]
        return qualified[0]

    # --- market data ---

    def _ticker(self, symbol: str):
        """Return a live Ticker for the symbol; subscribe on first request."""
        norm = self.normalize_symbol(symbol)
        existing = self._tickers.get(norm)
        if existing is not None:
            return existing
        contract = self._contract(symbol)
        # For options, request tick type 106 (option model computation) to get
        # modelGreeks (delta, gamma, vega, theta, impliedVol, undPrice).
        generic_ticks = "106" if self.is_option(symbol) else ""
        ticker = self._ib.reqMktData(contract, generic_ticks, False, False)
        # Options need longer for model computation to arrive.
        self._ib.sleep(2.0 if self.is_option(symbol) else 1.0)
        self._tickers[norm] = ticker
        return ticker

    def price(self, symbol: str) -> Optional[float]:
        try:
            ticker = self._ticker(symbol)
            # marketPrice() returns the midpoint when both bid/ask are present,
            # else last, else close. Returns NaN if no data yet — fall back to
            # the cached last-known price in that case.
            import math as _math
            mp = ticker.marketPrice()
            if mp is not None and not _math.isnan(mp):
                self._last_price[self.normalize_symbol(symbol)] = float(mp)
                return float(mp)
            for attr in ("last", "close", "bid", "ask"):
                v = getattr(ticker, attr, None)
                if v is not None and not _math.isnan(v):
                    self._last_price[self.normalize_symbol(symbol)] = float(v)
                    return float(v)
            return self._last_price.get(self.normalize_symbol(symbol))
        except Exception as e:
            log_err(f"[IBKRBroker.price] {symbol}: {e}")
            return self._last_price.get(self.normalize_symbol(symbol))

    def market_is_open(self, symbol: str) -> bool:
        # Crypto trades ~24/7 on PAXOS. Equities follow standard US hours;
        # the paper gateway must not rely on a broker rejection after a side
        # effect, so non-crypto stays closed until liquidHours is parsed by an
        # authoritative adapter.
        if self.is_crypto(symbol):
            return True
        return False

    def greeks(self, symbol: str) -> Dict[str, Any]:
        """Return live Greeks from IBKR's option model (tick type 106)."""
        empty = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "iv": 0.0, "underlying_price": 0.0}
        if not self.is_option(symbol):
            return empty
        try:
            ticker = self._ticker(symbol)
            mg = getattr(ticker, "modelGreeks", None)
            if mg is None:
                return empty
            return {
                "delta": float(getattr(mg, "delta", 0.0) or 0.0),
                "gamma": float(getattr(mg, "gamma", 0.0) or 0.0),
                "theta": float(getattr(mg, "theta", 0.0) or 0.0),
                "vega": float(getattr(mg, "vega", 0.0) or 0.0),
                "iv": float(getattr(mg, "impliedVol", 0.0) or 0.0),
                "underlying_price": float(getattr(mg, "undPrice", 0.0) or 0.0),
            }
        except Exception as e:
            log_err(f"[IBKRBroker.greeks] {symbol}: {e}")
            return empty

    def underlying_price(self, symbol: str) -> Optional[float]:
        """Return the underlying price for an option from modelGreeks or direct lookup."""
        if not self.is_option(symbol):
            return None
        g = self.greeks(symbol)
        if g["underlying_price"] > 0:
            return g["underlying_price"]
        m = self._OPTION_RE.match(symbol.upper())
        if m:
            return self.price(m.group(1))
        return None

    def days_to_expiry(self, symbol: str) -> float:
        """Return calendar days until option expiry."""
        if not self.is_option(symbol):
            return float("inf")
        m = self._OPTION_RE.match(symbol.upper())
        if not m:
            return float("inf")
        expiry_str = m.group(2)
        exp_date = datetime(int(expiry_str[:4]), int(expiry_str[4:6]), int(expiry_str[6:8]), tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        return max((exp_date - now).total_seconds() / 86400.0, 0.0)

    def option_chain(self, underlying: str, expiry: str = None):
        """Discover available option strikes and expirations for an underlying."""
        try:
            from ib_insync import Stock
            contract = Stock(underlying.upper(), "SMART", "USD")
            self._ib.qualifyContracts(contract)
            chains = self._ib.reqSecDefOptParams(underlying.upper(), "", "STK", contract.conId)
            results = []
            for chain in chains:
                if chain.exchange != "SMART":
                    continue
                for exp in sorted(chain.expirations):
                    if expiry is not None and exp != expiry:
                        continue
                    results.append({
                        "expiry": exp,
                        "strikes": sorted(float(s) for s in chain.strikes),
                        "rights": ["C", "P"],
                    })
            return results
        except Exception as e:
            log_err(f"[IBKRBroker.option_chain] {underlying}: {e}")
            return []

    def _prev_option_positions(self):
        """Track option positions for assignment detection."""
        if not hasattr(self, "_option_pos_snapshot"):
            self._option_pos_snapshot = {}
        return self._option_pos_snapshot

    def _assignment_check(self):
        """Detect assignment/exercise events by comparing position snapshots."""
        prev = self._prev_option_positions()
        current = {}
        for p in self._ib.positions(self._account):
            sym = getattr(p.contract, "localSymbol", "") or str(p.contract.conId)
            if hasattr(p.contract, "right") and p.contract.right in ("C", "P"):
                current[sym] = float(p.position)
        for sym, old_qty in prev.items():
            new_qty = current.get(sym, 0.0)
            if old_qty != 0.0 and new_qty == 0.0:
                log_err(json.dumps({"event": "assignment", "symbol": sym, "qty_before": old_qty, "qty_after": 0.0}))
        self._option_pos_snapshot = current

    def _expiry_warning_check(self):
        """Warn when held options are near expiry (DTE <= 3)."""
        for p in self._ib.positions(self._account):
            if not hasattr(p.contract, "right") or p.contract.right not in ("C", "P"):
                continue
            if float(p.position) == 0.0:
                continue
            exp_str = getattr(p.contract, "lastTradeDateOrContractMonth", "")
            if len(exp_str) >= 8:
                try:
                    exp_date = datetime(int(exp_str[:4]), int(exp_str[4:6]), int(exp_str[6:8]), tzinfo=timezone.utc)
                    dte = (exp_date - datetime.now(timezone.utc)).days
                    if dte <= 3:
                        sym = getattr(p.contract, "localSymbol", str(p.contract.conId))
                        log_err(f"[EXPIRY_WARNING] {sym}: {dte} days to expiry, position={p.position}")
                except Exception:
                    pass

    def fetch_bar(self, symbol: str, interval: str) -> Optional[Dict[str, Any]]:
        """Return the most recent completed bar for symbol at interval.

        Backed by ib.reqHistoricalData. We request a small window (2x the
        bar size, give or take) so the call is fast and well under IBKR's
        ~60-requests-per-10-min pacing cap — the live runner calls this
        once per bar interval, so we're nowhere near saturating.
        """
        params = self._INTERVAL_TO_BARSIZE.get(interval)
        if params is None:
            log_err(f"[IBKRBroker.fetch_bar] unsupported interval {interval!r}")
            return None
        bar_size, duration = params

        contract = self._contract(symbol)
        # PAXOS crypto bars stream on AGGTRADES; options use MIDPOINT (sparse
        # trade data); equities on TRADES.
        if self.is_option(symbol):
            what_to_show = "MIDPOINT"
        elif self.is_crypto(symbol):
            what_to_show = "AGGTRADES"
        else:
            what_to_show = "TRADES"
        # useRTH=False so after-hours equity bars also come through (live algos
        # may want to see the pre-/post-market action even if they don't
        # actually trade then).
        try:
            bars = self._ib.reqHistoricalData(
                contract,
                endDateTime="",          # '' = up to now
                durationStr=duration,
                barSizeSetting=bar_size,
                whatToShow=what_to_show,
                useRTH=False,
                formatDate=2,            # epoch seconds (avoids tz parsing)
                keepUpToDate=False,
            )
        except Exception as e:
            log_err(f"[IBKRBroker.fetch_bar] {symbol} {interval}: {e}")
            return None

        if not bars:
            return None
        latest, finality = newest_finalized_bar(
            bars,
            interval,
            lambda item: datetime.fromtimestamp(float(item.date), tz=timezone.utc)
            if isinstance(item.date, (int, float)) else item.date,
        )
        if latest is None:
            return None
        # ib_insync gives us a BarData with .date as a datetime when
        # formatDate=1 or as an int epoch when formatDate=2. Normalize to ISO.
        ts = latest.date
        if isinstance(ts, (int, float)):
            ts_iso = datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
        elif hasattr(ts, "isoformat"):
            ts_iso = ts.isoformat()
        else:
            ts_iso = str(ts)
        bar = {
            "timestamp": ts_iso,
            "open": float(latest.open),
            "high": float(latest.high),
            "low": float(latest.low),
            "close": float(latest.close),
            "volume": float(latest.volume),
            **finality,
        }
        if self.is_option(symbol):
            g = self.greeks(symbol)
            bar["underlying_close"] = float(g.get("underlying_price") or 0.0)
            bar["iv"] = float(g.get("iv") or 0.0)
            bar["delta"] = float(g.get("delta") or 0.0)
            bar["gamma"] = float(g.get("gamma") or 0.0)
            bar["theta"] = float(g.get("theta") or 0.0)
            bar["vega"] = float(g.get("vega") or 0.0)
            bar["dte"] = float(self.days_to_expiry(symbol))
        return bar

    # --- account state ---

    def _account_summary_with_currency(self) -> Dict[str, Tuple[float, str]]:
        out: Dict[str, Tuple[float, str]] = {}

        def ingest(values, require_account: bool = False) -> None:
            for v in values:
                if require_account and getattr(v, "account", None) != self._account:
                    continue
                tag = getattr(v, "tag", None)
                if tag not in (self._CASH_TAG, self._EQUITY_TAG):
                    continue
                try:
                    value = float(getattr(v, "value"))
                except (TypeError, ValueError):
                    continue
                out[tag] = (value, str(getattr(v, "currency", "") or ""))

        try:
            # Do not filter by currency for display: IBKR paper accounts can
            # report CAD, EUR, etc. depending on account base currency.
            ingest(self._ib.accountSummary(self._account))
            if not out:
                ingest(self._ib.accountValues(), require_account=True)
        except Exception as e:
            log_err(f"[IBKRBroker._account_summary] {e}")
        return out

    def _account_summary(self) -> Dict[str, float]:
        return {tag: value for tag, (value, _currency) in self._account_summary_with_currency().items()}

    def _cash_for_default_buy(self) -> Tuple[Optional[float], Optional[str]]:
        cash, currency = self._account_summary_with_currency().get(self._CASH_TAG, (0.0, ""))
        currency = currency.upper()
        if currency and currency != "USD":
            return None, (
                f"default cash sizing requires USD cash, account cash is {currency}; "
                "pass explicit qty or notional"
            )
        return cash, None

    def cash(self) -> float:
        return self._account_summary().get(self._CASH_TAG, 0.0)

    def equity(self) -> float:
        return self._account_summary().get(self._EQUITY_TAG, 0.0)

    def execution_snapshot(self, symbol: str) -> Dict[str, Any]:
        summary: Dict[str, float] = {}
        for value in self._ib.accountSummary(self._account):
            if getattr(value, "tag", None) in (self._CASH_TAG, self._EQUITY_TAG):
                summary[str(value.tag)] = float(value.value)
        if self._CASH_TAG not in summary or self._EQUITY_TAG not in summary:
            raise RuntimeError("IBKR account snapshot missing cash or equity")
        position_rows = [item for item in self._ib.positions(self._account) if float(item.position) != 0]
        tickers = self._ib.reqTickers(*(item.contract for item in position_rows)) if position_rows else []
        if len(tickers) != len(position_rows):
            raise RuntimeError("IBKR execution snapshot missing one or more position marks")
        positions: Dict[str, Dict[str, float]] = {}
        target_contract = self._contract(symbol)
        for item, ticker in zip(position_rows, tickers):
            qty = float(item.position)
            mark = float(ticker.marketPrice())
            if not math.isfinite(mark) or mark <= 0:
                raise RuntimeError(f"IBKR execution snapshot cannot value conId={item.contract.conId}")
            key = symbol if item.contract.conId == target_contract.conId else (
                getattr(item.contract, "localSymbol", "") or getattr(item.contract, "symbol", "")
            )
            positions[str(key)] = {"qty": qty, "mark": mark}
        return {"cash": summary[self._CASH_TAG], "equity": summary[self._EQUITY_TAG], "positions": positions}

    def position(self, symbol: str) -> float:
        try:
            contract = self._contract(symbol)
            for p in self._ib.positions(self._account):
                if p.contract.conId == contract.conId:
                    return float(p.position)
        except Exception as e:
            log_err(f"[IBKRBroker.position] {symbol}: {e}")
        return 0.0

    # --- order placement ---

    def _place_market_order(self, symbol: str, side: str, qty: float, reason=None, features=None) -> OrderRecord:
        import math as _math
        from ib_insync import MarketOrder
        contract = self._contract(symbol)
        # IBKR rejects fractional shares on equities, options (always int
        # contracts), and futures (always int contracts). Crypto is the only
        # fractional-allowed case.
        if not self.is_crypto(symbol):
            qty = int(_math.floor(abs(qty)))
        if qty <= 0:
            return OrderRecord(
                order_id="rejected",
                symbol=symbol,
                side=side.lower(),
                qty=0,
                price=0.0,
                status="rejected: qty <= 0 after flooring",
                ts=datetime.now(timezone.utc).isoformat(),
                reason=reason,
                features=features,
            )
        order = MarketOrder(side, qty, account=self._account)
        trade = self._ib.placeOrder(contract, order)
        # Give TWS a beat to ack. The Trade object is mutated in place as
        # status updates arrive, so this short wait usually catches the
        # 'Submitted' transition; fills may take longer and remain visible
        # through subsequent position() calls.
        self._ib.sleep(0.5)
        status = trade.orderStatus.status or "Submitted"
        filled_price = trade.orderStatus.avgFillPrice or self.price(symbol) or 0.0
        return OrderRecord(
            order_id=str(trade.order.orderId),
            symbol=symbol,
            side=side.lower(),
            qty=float(qty),
            price=float(filled_price),
            status=status,
            ts=datetime.now(timezone.utc).isoformat(),
            reason=reason,
            features=features,
        )

    def _per_unit_cost(self, symbol: str, price: float) -> float:
        """How much cash one unit of symbol consumes for sizing math.

        - Equity / crypto: 1 share/coin = price.
        - Option: 1 contract = price * 100 (standard equity option multiplier).
        - Future: undefined here — futures use margin and have to be sized
          explicitly. Caller refuses default-cash sizing in that branch.
        """
        if self.is_option(symbol):
            return price * self._OPTION_MULTIPLIER
        return price

    def buy(self, symbol: str, qty: Optional[float] = None, notional: Optional[float] = None, reason: Optional[str] = None, features: Optional[Dict[str, Any]] = None) -> OrderRecord:
        # Futures use margin not cash — default sizing is unsafe. Force explicit qty.
        if self.is_future(symbol) and qty is None:
            return OrderRecord(
                order_id="rejected", symbol=symbol, side="buy", qty=0, price=0.0,
                status="rejected: futures require explicit qty (margin-based; cannot size from cash)",
                ts=datetime.now(timezone.utc).isoformat(), reason=reason, features=features,
            )

        if qty is None and notional is None:
            # Default: spend all available cash. For options, divide by
            # (price * 100) so we're not buying 100x the contracts we think.
            px = self.price(symbol) or 0.0
            if px <= 0:
                return OrderRecord(
                    order_id="rejected", symbol=symbol, side="buy", qty=0, price=0.0,
                    status="rejected: no price", ts=datetime.now(timezone.utc).isoformat(), reason=reason, features=features,
                )
            cash, reject_reason = self._cash_for_default_buy()
            if reject_reason:
                return OrderRecord(
                    order_id="rejected", symbol=symbol, side="buy", qty=0, price=0.0,
                    status=f"rejected: {reject_reason}", ts=datetime.now(timezone.utc).isoformat(),
                )
            per_unit = self._per_unit_cost(symbol, px)
            qty = (cash or 0.0) / per_unit if per_unit > 0 else 0
        elif qty is None:
            px = self.price(symbol) or 0.0
            if px <= 0:
                return OrderRecord(
                    order_id="rejected", symbol=symbol, side="buy", qty=0, price=0.0,
                    status="rejected: no price for notional sizing", ts=datetime.now(timezone.utc).isoformat(), reason=reason, features=features,
                )
            per_unit = self._per_unit_cost(symbol, px)
            qty = (notional or 0.0) / per_unit if per_unit > 0 else 0
        return self._place_market_order(symbol, "BUY", float(qty), reason=reason, features=features)

    def sell(self, symbol: str, qty: Optional[float] = None, notional: Optional[float] = None, reason: Optional[str] = None, features: Optional[Dict[str, Any]] = None) -> OrderRecord:
        if qty is None and notional is None:
            # Default: close the entire position (works for any instrument
            # type — position() already returns contracts for options/futures).
            qty = self.position(symbol)
            if qty <= 0:
                return OrderRecord(
                    order_id="rejected", symbol=symbol, side="sell", qty=0, price=0.0,
                    status="rejected: no position to close", ts=datetime.now(timezone.utc).isoformat(), reason=reason, features=features,
                )
        elif qty is None:
            px = self.price(symbol) or 0.0
            if px <= 0:
                return OrderRecord(
                    order_id="rejected", symbol=symbol, side="sell", qty=0, price=0.0,
                    status="rejected: no price for notional sizing", ts=datetime.now(timezone.utc).isoformat(), reason=reason, features=features,
                )
            per_unit = self._per_unit_cost(symbol, px)
            qty = (notional or 0.0) / per_unit if per_unit > 0 else 0
        return self._place_market_order(symbol, "SELL", float(qty), reason=reason, features=features)


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
            raise  # propagate so the runner loop can count strategy errors

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
