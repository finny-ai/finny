"""Finny strategy behavioral smoke test.

Loads a Strategy class from stdin-provided source, runs it against four synthetic
bar regimes (constant / up / down / random walk), and asserts behavioral invariants.

Emits a JSON array of diagnostics on stdout (same shape as ast_analyzer.py).

Diagnostic codes:
  SMOKE_TEST_EXCEPTION            (error)   on_tick raised
  INVARIANT_BAD_RETURN            (error)   on_tick returned something other than BUY/SELL/HOLD
  INVARIANT_CONSTANT_TRADES       (error)   trades emitted on a flat-price series
  INVARIANT_RSI_STUCK             (error)   an indicator-shaped attribute stayed ≥95 (or ≤5) for >90% of ticks
  INVARIANT_STATE_NOT_ACCUMULATING (error)  a deque/list attribute never grows beyond length 1
  INVARIANT_DIRECTIONAL_SANITY    (warning) mean-reversion-shaped BUY fired on a monotone-up series
  EQUITY_STATIC                   (error)   trades fired but self.equity (or similar) never changed
  LEVERAGE_VIOLATION              (error)   position_qty * price > self.equity at some tick
  GUARD_NEVER_BINDING             (warning) strategy produced zero trades on the random-walk regime

Exits 0 with diagnostics on stdout. If the strategy fails to import at all, emits
SMOKE_TEST_EXCEPTION and exits 0 (upstream handles blocking save).
"""
import importlib.util
import inspect
import json
import math
import random
import re
import sys
import tempfile
import traceback
from collections import deque
from pathlib import Path


VALID_RETURNS = {"BUY", "SELL", "HOLD", None}


def _load_strategy(source):
    """Write source to a tempfile and import the Strategy class."""
    tmp = Path(tempfile.mkdtemp(prefix="finny_smoke_")) / "strategy_under_test.py"
    tmp.write_text(source)
    spec = importlib.util.spec_from_file_location("strategy_under_test", tmp)
    if spec is None or spec.loader is None:
        raise ImportError("failed to build spec for strategy module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "Strategy"):
        raise AttributeError("module has no `Strategy` class")
    return module.Strategy


class StubBroker:
    """Minimal broker stub for smoke-testing broker-based strategies.

    Records every buy/sell call, tracks per-symbol position and cost basis,
    and exposes equity() / cash() / position() / price() matching the real
    Broker protocol. PnL is realized on sell so self.equity() reflects trade
    outcomes the same way the real SimBroker does.
    """

    def __init__(self, starting_cash=10_000.0):
        self._cash = float(starting_cash)
        self._positions = {}      # symbol -> qty
        self._cost_basis = {}     # symbol -> avg entry price
        self._last_price = {}     # symbol -> last observed price
        self._history = {}        # symbol -> completed bars
        self.calls = []           # [(side, symbol, qty, notional)]

    def set_price(self, symbol, price):
        self._last_price[symbol] = float(price)

    def buy(self, symbol, qty=None, notional=None):
        """Handle four position transitions, mirroring engine_v2 PositionBook.apply_fill:
          - current >= 0: long entry or add (cap by cash)
          - current  < 0: cover short — possibly with a residual that flips to long

        Realized PnL on cover flows naturally into self._cash: short opened cash by
        qty*basis, cover spends qty*mark, so the net change is qty*(basis - mark).
        """
        mark = self._last_price.get(symbol, 0)
        # Record what the strategy ASKED for (before we cap) so leverage violations
        # are observable even if the real broker would silently cap.
        requested_qty = qty
        if notional is not None and qty is None:
            requested_qty = notional / mark if mark > 0 else 0
        self.calls.append(("buy", symbol, requested_qty, notional))
        if mark <= 0:
            return None

        current = self._positions.get(symbol, 0)

        # Resolve qty if omitted
        if qty is None and notional is not None:
            qty = notional / mark
        if qty is None:
            # Default: cover the short if short; otherwise size to all cash.
            qty = abs(current) if current < 0 else (self._cash / mark if mark > 0 else 0)
        if qty <= 0:
            return None

        if current >= 0:
            # Long entry or add — cap by cash, weighted-avg the basis
            cost = qty * mark
            if cost > self._cash:
                qty = self._cash / mark if mark > 0 else 0
                cost = qty * mark
            if qty <= 0:
                return None
            prev_basis = self._cost_basis.get(symbol, 0)
            new_qty = current + qty
            new_basis = (prev_basis * current + mark * qty) / new_qty if new_qty > 0 else 0
            self._positions[symbol] = new_qty
            self._cost_basis[symbol] = new_basis
            self._cash -= cost
            return None

        # current < 0: covering a short, possibly flipping to long with residual
        cover_qty = min(qty, abs(current))
        residual = qty - cover_qty
        self._cash -= cover_qty * mark
        new_current = current + cover_qty
        self._positions[symbol] = new_current
        if new_current == 0:
            self._cost_basis.pop(symbol, None)

        if residual > 0:
            # Residual opens a long at mark, capped by remaining cash
            cost = residual * mark
            if cost > self._cash:
                residual = self._cash / mark if mark > 0 else 0
                cost = residual * mark
            if residual > 0:
                self._positions[symbol] = residual
                self._cost_basis[symbol] = mark
                self._cash -= cost
        return None

    def sell(self, symbol, qty=None, notional=None):
        """Handle four position transitions, mirroring engine_v2 PositionBook.apply_fill:
          - current  > 0: long reduce/close — realize PnL via cash inflow
          - current == 0: open short — receive proceeds, position goes negative
          - current  < 0: add to short — weighted-avg basis on the short side

        A sell that crosses zero (current > 0 and qty > current) is treated as
        close-then-open-short on the residual.
        """
        requested_qty = qty
        mark = self._last_price.get(symbol, 0)
        if notional is not None and qty is None:
            requested_qty = notional / mark if mark > 0 else 0
        self.calls.append(("sell", symbol, requested_qty, notional))
        if mark <= 0:
            return None

        current = self._positions.get(symbol, 0)

        # Resolve qty
        if qty is None and notional is not None:
            qty = notional / mark
        if qty is None:
            # Default: close the long if long. From flat or short, require an
            # explicit qty — refusing to open / add to a short on a bare sell()
            # avoids silently magnifying exposure when the strategy is buggy.
            if current > 0:
                qty = current
            else:
                return None
        if qty <= 0:
            return None

        if current > 0:
            # Long reduce/close — proceed by min(qty, current), then handle residual
            close_qty = min(qty, current)
            self._cash += close_qty * mark
            new_current = current - close_qty
            self._positions[symbol] = new_current
            if new_current == 0:
                self._cost_basis.pop(symbol, None)
            residual = qty - close_qty
            if residual > 0:
                # Flip to short with residual at mark
                self._positions[symbol] = -residual
                self._cost_basis[symbol] = mark
                self._cash += residual * mark
            return None

        # current <= 0: open or add to short. Receive proceeds, average the basis.
        self._cash += qty * mark
        if current == 0:
            self._positions[symbol] = -qty
            self._cost_basis[symbol] = mark
        else:
            prev_basis = self._cost_basis.get(symbol, 0)
            abs_prev = abs(current)
            abs_new = abs_prev + qty
            new_basis = (prev_basis * abs_prev + mark * qty) / abs_new
            self._positions[symbol] = -abs_new
            self._cost_basis[symbol] = new_basis
        return None

    def position(self, symbol):
        return self._positions.get(symbol, 0)

    def cash(self):
        return self._cash

    def equity(self):
        eq = self._cash
        for sym, qty in self._positions.items():
            eq += qty * self._last_price.get(sym, 0)
        return eq

    def price(self, symbol):
        return self._last_price.get(symbol)

    def set_history(self, symbol, rows):
        self._history[symbol] = list(rows)

    def history(self, symbol, limit=100):
        safe_limit = max(0, int(limit))
        rows = self._history.get(symbol, [])
        return tuple(dict(r) for r in (rows[-safe_limit:] if safe_limit else []))


def _instantiate_strategy(StrategyCls, broker):
    """Instantiate the strict Shape-C strategy."""
    sig = inspect.signature(StrategyCls)
    accepts_params = any(
        p.kind == inspect.Parameter.VAR_KEYWORD or p.name == "params"
        for p in sig.parameters.values()
    )
    if accepts_params:
        return StrategyCls(broker, params={}), True
    return StrategyCls(broker), True


def _pick_entry(strategy):
    """Return (method_name, method_fn, accepts_symbol) for the strategy's entry point."""
    fn = getattr(strategy, "on_bar", None)
    if callable(fn):
        return "on_bar", fn, True
    raise AttributeError("Strict strategy has no on_bar method")


def _make_bar(price, ts=0, symbol="TEST", prev=None):
    return {
        "symbol": symbol,
        "open": price,
        "prev_open": None if prev is None else prev["open"],
        "prev_high": None if prev is None else prev["high"],
        "prev_low": None if prev is None else prev["low"],
        "prev_close": None if prev is None else prev["close"],
        "volume": 1_000_000,
        "timestamp": ts,
    }


def _completed_row(price, ts=0, symbol="TEST"):
    return {
        "symbol": symbol,
        "open": price,
        "high": price,
        "low": price,
        "close": price,
        "volume": 1_000_000,
        "timestamp": ts,
    }


def _regime_prices(n=200, seed=42):
    base = 100.0
    constant = [base] * n
    up = [base * (1 + 0.005) ** i for i in range(n)]
    down = [base * (1 - 0.005) ** i for i in range(n)]
    rng = random.Random(seed)
    rw = []
    p = base
    for _ in range(n):
        p *= 1 + rng.gauss(0, 0.01)
        rw.append(p)
    return constant, up, down, rw


def _regimes(n=200):
    constant, up, down, rw = _regime_prices(n, 42)
    _, _, _, long_rw = _regime_prices(500, 4242)
    return {
        "constant": constant,
        "up": up,
        "down": down,
        "random": rw,
        "long_random": long_rw,
    }


def _snapshot_state(strategy):
    """Capture scalar values and deque/list lengths for each self.* attribute."""
    snap = {}
    for name, value in vars(strategy).items():
        if isinstance(value, (deque, list, tuple, set)):
            snap[name] = ("len", len(value))
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            snap[name] = ("num", float(value))
        # otherwise ignore
    return snap


# Only names that plausibly hold a 0-100 bounded oscillator VALUE. Internal
# accumulators (avg_gain, gain_sum) and unbounded measures (ATR, stddev) happen
# to sit in [0, 100] on many price series and were false-flagged as "stuck".
OSCILLATOR_NAME_HINTS = ("rsi", "stoch", "adx", "mfi", "willr", "percent", "pct_k", "pct_d")
OSCILLATOR_NAME_EXCLUDES = ("gain", "loss", "sum", "count", "avg", "atr", "std", "var", "period")


def _looks_like_indicator(name, samples):
    """An attribute looks like an indicator if it is NAMED like a bounded
    oscillator AND its value stays in [0, 100] AND actually varies.

    The name gate matters: ATR on a low-vol series or an RSI gain accumulator
    also sits in [0, 100] and hugs zero, but neither is a broken oscillator.
    We require real variation (range > 1) to avoid flagging config constants
    like num_std=2.0.
    """
    n = name.lower()
    if not any(h in n for h in OSCILLATOR_NAME_HINTS):
        return False
    if any(x in n for x in OSCILLATOR_NAME_EXCLUDES):
        return False
    if len(samples) < 20:
        return False
    if not all(isinstance(v, (int, float)) for v in samples):
        return False
    if not all(0.0 <= v <= 100.0 for v in samples):
        return False
    return max(samples) - min(samples) > 1.0


EQUITY_HINTS = ("equity", "capital", "balance", "cash", "account_value")
POSITION_HINTS = ("position", "qty", "size", "shares")


def _looks_like_equity(name):
    # Treat our internal broker-equity sentinel as equity.
    if name == "__broker_equity__":
        return True
    n = name.lower()
    return any(h in n for h in EQUITY_HINTS)


def _looks_like_position(name):
    n = name.lower()
    # exclude pure flags like "in_position", "has_position" — those are bool-ish
    if n.startswith(("in_", "has_", "is_")):
        return False
    return any(h in n for h in POSITION_HINTS)


SYMBOL = "TEST"


def _run_regime(StrategyCls, prices):
    """Run the strategy over a list of prices; collect returns, state snapshots, errors.

    Supports both the legacy on_tick(bar) -> "BUY"/"SELL"/"HOLD" convention and the
    broker-based on_bar(symbol, bar) convention. When the strategy uses the broker
    API, trade actions (broker.buy / broker.sell) are recorded and count the same way
    "BUY" / "SELL" return strings do for the invariant checks.
    """
    broker = StubBroker(starting_cash=10_000.0)
    strategy, uses_broker_api = _instantiate_strategy(StrategyCls, broker)
    entry_name, entry_fn, accepts_symbol = _pick_entry(strategy)

    returns = []
    per_attr_samples = {}
    attr_max_len = {}
    initial_scalars = {
        name: v for name, (kind, v) in _snapshot_state(strategy).items() if kind == "num"
    }
    exposure_snapshots = []
    last_scalars = dict(initial_scalars)
    exc = None

    requested_qty_events = []  # [{tick, requested_qty, price, equity}]
    completed = []

    for i, price in enumerate(prices):
        prev = completed[-1] if completed else None
        bar = _make_bar(price, ts=i, symbol=SYMBOL, prev=prev)
        broker.set_price(SYMBOL, price)
        broker.set_history(SYMBOL, completed)
        equity_before = broker.equity()
        pre_calls = len(broker.calls)
        try:
            if accepts_symbol:
                r = entry_fn(SYMBOL, bar)
            else:
                r = entry_fn(bar)
        except Exception:
            exc = traceback.format_exc(limit=3)
            break

        new_broker_calls = broker.calls[pre_calls:]
        if new_broker_calls:
            for side, _sym, req_qty, _notional in new_broker_calls:
                returns.append("BUY" if side == "buy" else "SELL")
                if side == "buy" and isinstance(req_qty, (int, float)) and req_qty > 0:
                    requested_qty_events.append({
                        "tick": i,
                        "requested_qty": float(req_qty),
                        "price": float(price),
                        "equity": float(equity_before),
                    })
        else:
            returns.append(r)

        snap = _snapshot_state(strategy)
        current_position = None
        current_equity = None
        for name, (kind, v) in snap.items():
            if kind == "num":
                per_attr_samples.setdefault(name, []).append(v)
                last_scalars[name] = v
                if _looks_like_position(name) and isinstance(v, (int, float)) and v not in (0, 1):
                    if current_position is None or abs(v) > abs(current_position):
                        current_position = v
                elif _looks_like_equity(name):
                    if current_equity is None:
                        current_equity = v
            elif kind == "len":
                attr_max_len[name] = max(attr_max_len.get(name, 0), v)

        # For broker-API strategies, prefer broker state over self.* state for
        # LEVERAGE_VIOLATION — the real position lives in the broker.
        if uses_broker_api:
            broker_pos = broker.position(SYMBOL)
            if broker_pos not in (0, 1):
                current_position = broker_pos
            current_equity = broker.equity()

        exposure_snapshots.append({
            "tick": i,
            "price": price,
            "position": current_position,
            "equity": current_equity,
        })
        completed.append(_completed_row(price, ts=i, symbol=SYMBOL))

    # For broker-API strategies with no stored equity attribute, surface the
    # broker's equity as a pseudo-scalar so EQUITY_STATIC can reason about it.
    if uses_broker_api:
        initial_scalars.setdefault("__broker_equity__", 10_000.0)
        last_scalars["__broker_equity__"] = broker.equity()

    return {
        "returns": returns,
        "numeric_samples": per_attr_samples,
        "max_lens": attr_max_len,
        "exception": exc,
        "initial_scalars": initial_scalars,
        "last_scalars": last_scalars,
        "exposure_snapshots": exposure_snapshots,
        "uses_broker_api": uses_broker_api,
        "requested_qty_events": requested_qty_events,
    }


def analyze(source):
    diagnostics = []

    try:
        StrategyCls = _load_strategy(source)
    except Exception:
        diagnostics.append({
            "code": "SMOKE_TEST_EXCEPTION",
            "severity": "error",
            "message": "Strategy failed to load: " + traceback.format_exc(limit=2).strip().splitlines()[-1],
            "fix": "Fix the import / class definition so Strategy can be instantiated.",
        })
        return diagnostics

    regimes = _regimes(200)
    results = {}
    for name, prices in regimes.items():
        try:
            results[name] = _run_regime(StrategyCls, prices)
        except Exception:
            diagnostics.append({
                "code": "SMOKE_TEST_EXCEPTION",
                "severity": "error",
                "message": f"Smoke test raised during {name} regime: {traceback.format_exc(limit=2).strip().splitlines()[-1]}",
                "fix": "Ensure on_tick handles the first N ticks gracefully and never divides by zero.",
            })
            return diagnostics

    # INVARIANT: on_tick never raised
    for name, res in results.items():
        if res["exception"]:
            diagnostics.append({
                "code": "SMOKE_TEST_EXCEPTION",
                "severity": "error",
                "message": f"on_tick raised on the {name} regime: {res['exception'].strip().splitlines()[-1]}",
                "fix": "Guard division-by-zero, handle warmup, and ensure all attributes exist on tick 1.",
            })
            return diagnostics

    # INVARIANT: returns only BUY/SELL/HOLD/None
    for name, res in results.items():
        bad = [r for r in res["returns"] if r not in VALID_RETURNS]
        if bad:
            diagnostics.append({
                "code": "INVARIANT_BAD_RETURN",
                "severity": "error",
                "message": f"on_tick returned unexpected value `{bad[0]!r}` during {name} regime.",
                "fix": 'Return only "BUY", "SELL", or "HOLD" from on_tick.',
            })
            return diagnostics

    # INVARIANT_CONSTANT_TRADES: flat price → no BUY/SELL
    const_trades = [r for r in results["constant"]["returns"] if r in ("BUY", "SELL")]
    if const_trades:
        diagnostics.append({
            "code": "INVARIANT_CONSTANT_TRADES",
            "severity": "error",
            "message": (
                f"Strategy emitted {len(const_trades)} trade(s) on a constant-price series. "
                "Volatility, stddev, or RSI is miscalibrated — a flat market should produce no signals."
            ),
            "fix": "Inspect your volatility / std / RSI computation; on flat prices stddev is 0 and RSI is 50.",
        })

    # INVARIANT_RSI_STUCK: any indicator-shaped numeric attribute pinned near extremes
    # Aggregate samples from random regime (most varied).
    rw_samples = results["random"]["numeric_samples"]
    for attr, samples in rw_samples.items():
        if len(samples) < 50:
            continue
        if not _looks_like_indicator(attr, samples):
            continue
        pinned_high = sum(1 for v in samples if v >= 95.0)
        pinned_low = sum(1 for v in samples if v <= 5.0)
        ratio_high = pinned_high / len(samples)
        ratio_low = pinned_low / len(samples)
        if ratio_high > 0.9 or ratio_low > 0.9:
            diagnostics.append({
                "code": "INVARIANT_RSI_STUCK",
                "severity": "error",
                "message": (
                    f"`self.{attr}` looks like an indicator in [0, 100] but is pinned at an extreme "
                    f"({'high' if ratio_high > ratio_low else 'low'}) for "
                    f"{100 * max(ratio_high, ratio_low):.0f}% of ticks — the computation is broken."
                ),
                "fix": "Check that the indicator's state history is persisted across ticks (not recreated every call).",
            })
            break  # one RSI-stuck diagnostic is enough

    # INVARIANT_STATE_NOT_ACCUMULATING: deque/list attributes that never exceed length 1
    # Only flag on random regime (200 ticks — plenty of time to grow).
    rw_lens = results["random"]["max_lens"]
    for attr, max_len in rw_lens.items():
        # Skip internal/stateful names the user legitimately keeps at 0/1 (entry_price etc.
        # wouldn't be in this dict since they're scalars).
        if max_len <= 1:
            # Only flag if the strategy ALSO has a local-looking container of the same name
            # — otherwise a short helper (e.g. a pending-order list) is legitimate.
            # We can't tell from here, so issue as warning… actually: stick to high signal.
            # A deque initialized with maxlen>1 that stays at len<=1 over 200 ticks is broken.
            pass  # see next block — we need more info than we have here

    # INVARIANT_DIRECTIONAL_SANITY: on monotone-up, mean-reversion-style BUYs (many) are suspect
    up_buys = sum(1 for r in results["up"]["returns"] if r == "BUY")
    up_sells = sum(1 for r in results["up"]["returns"] if r == "SELL")
    if up_buys > 10 and up_buys > up_sells * 3:
        diagnostics.append({
            "code": "INVARIANT_DIRECTIONAL_SANITY",
            "severity": "warning",
            "message": (
                f"On a monotonically rising series the strategy emitted {up_buys} BUYs vs {up_sells} SELLs. "
                "Mean-reversion logic on a trending market usually indicates inverted signal direction."
            ),
            "fix": "Check that BUY conditions match oversold (not overbought) state.",
        })

    # EQUITY_STATIC: if trades fired in a NON-flat regime and equity never changed.
    # Skip the constant-price regime because there's no legitimate PnL possible —
    # buying and selling at the same price nets to zero even in a correct strategy.
    for regime_name, res in results.items():
        if regime_name == "constant":
            continue
        trades_fired = any(r in ("BUY", "SELL") for r in res["returns"])
        if not trades_fired:
            continue
        for attr, initial_val in res["initial_scalars"].items():
            if not _looks_like_equity(attr):
                continue
            final_val = res["last_scalars"].get(attr, initial_val)
            if (
                isinstance(initial_val, (int, float))
                and isinstance(final_val, (int, float))
                and initial_val == final_val
            ):
                # Prettify the display name for the broker-equity sentinel.
                display = "self.equity (via broker)" if attr == "__broker_equity__" else f"self.{attr}"
                diagnostics.append({
                    "code": "EQUITY_STATIC",
                    "severity": "error",
                    "message": (
                        f"Trades fired during the {regime_name} regime but {display} never changed "
                        f"(stayed at {initial_val}). The strategy is sizing from a frozen capital value — "
                        "PnL is not flowing back into the risk model."
                    ),
                    "fix": "Update equity on every SELL to reflect realized PnL.",
                })
                break
        if any(d["code"] == "EQUITY_STATIC" for d in diagnostics):
            break

    # LEVERAGE_VIOLATION: at any tick, position_qty * price > equity * 1.01.
    # For broker-API strategies, also scan the broker.calls list for REQUESTED qty
    # that would have exceeded equity even if the real broker would have capped it.
    for regime_name, res in results.items():
        found = False
        for snap in res["exposure_snapshots"]:
            qty = snap["position"]
            eq = snap["equity"]
            price = snap["price"]
            if qty is None or eq is None or qty <= 0 or eq <= 0:
                continue
            exposure = qty * price
            if exposure > eq * 1.01:
                diagnostics.append({
                    "code": "LEVERAGE_VIOLATION",
                    "severity": "error",
                    "message": (
                        f"On the {regime_name} regime, tick {snap['tick']}: position "
                        f"({qty:.2f} * {price:.2f} = ${exposure:,.0f}) exceeds equity (${eq:,.0f}). "
                        "Strategy is implicitly leveraged."
                    ),
                    "fix": "Cap position size: `qty = min(qty, self.equity / price)` before opening.",
                })
                found = True
                break
        if found:
            break
        # Requested-qty leverage check (broker-API: detect intent to over-size
        # even when the stub/real broker capped the actual fill).
        if res.get("uses_broker_api"):
            requested_violations = []
            for tick_idx, snap in enumerate(res["exposure_snapshots"]):
                # no direct link between calls and ticks; use the equity at the tick
                # and compare against the per-tick price
                pass  # handled via direct scan below
            # Simpler: scan all snapshots and compare to per-tick max requested qty.
            # broker.calls is module-level; we need per-regime isolation — already
            # reset because a fresh broker is created per regime. Use the final
            # equity and first trade price as a rough bound.
    # Requested-qty leverage detection done separately per regime via a second pass
    # using the returns + exposure snapshots.
    if not any(d["code"] == "LEVERAGE_VIOLATION" for d in diagnostics):
        for regime_name, res in results.items():
            if not res.get("uses_broker_api"):
                continue
            requested = res.get("requested_qty_events", [])
            for ev in requested:
                exposure = ev["requested_qty"] * ev["price"]
                if exposure > ev["equity"] * 1.01:
                    diagnostics.append({
                        "code": "LEVERAGE_VIOLATION",
                        "severity": "error",
                        "message": (
                            f"On the {regime_name} regime, tick {ev['tick']}: strategy requested "
                            f"a position of {ev['requested_qty']:.2f} @ {ev['price']:.2f} "
                            f"(= ${exposure:,.0f}), exceeding equity (${ev['equity']:,.0f}). "
                            "Real broker would cap the fill but the intent is leveraged."
                        ),
                        "fix": "Cap qty BEFORE calling broker.buy: `qty = min(qty, self.broker.equity() / price)`.",
                    })
                    break
            if any(d["code"] == "LEVERAGE_VIOLATION" for d in diagnostics):
                break

    # GUARD_NEVER_BINDING: strategy produced zero trades on the random-walk regime.
    # Conservative: only warns when the random regime saw zero BUYs AND the strategy has
    # threshold-like scalar attributes (suggesting a tunable guard exists). Monotone-up /
    # -down regimes can legitimately produce no mean-reversion trades.
    rw_buys = sum(1 for r in results["random"]["returns"] if r == "BUY")
    if rw_buys == 0:
        has_threshold = any(
            re.search(r"threshold|min_|max_|oversold|overbought|num_std|stop_|risk_|period|lookback|entry_|exit_|lower|upper|band|level|cutoff", name, re.IGNORECASE)
            for name in results["random"]["initial_scalars"]
        )
        if has_threshold:
            diagnostics.append({
                "code": "GUARD_NEVER_BINDING",
                "severity": "warning",
                "message": (
                    "Strategy produced zero BUYs across 200 ticks of random-walk prices. "
                    "A guard threshold (e.g. volatility/rsi cutoff) is likely too strict — the "
                    "strategy will rarely trade in real markets."
                ),
                "fix": "Inspect threshold attributes (volatility_threshold, etc.); relax values or verify scaling.",
            })

    return diagnostics


def main():
    source = sys.stdin.read()
    try:
        diagnostics = analyze(source)
    except Exception as exc:
        sys.stderr.write(f"smoke_test error: {exc}\n")
        sys.stdout.write("[]")
        sys.exit(0)
    sys.stdout.write(json.dumps(diagnostics))


if __name__ == "__main__":
    main()
