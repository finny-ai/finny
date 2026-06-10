"""Strict Shape-C strategy worker.

The parent process owns market data, broker state, fills, equity, metrics, and
artifacts. This child imports user strategy code, exposes only a narrow broker
proxy, and returns order intents over a JSONL protocol.
"""

from __future__ import annotations

import argparse
import builtins
import contextlib
import importlib.util
import inspect
import json
import sys
import traceback
from pathlib import Path
from types import MappingProxyType
from typing import Any, Dict, List, Optional


DENIED_IMPORT_ROOTS = {
    "asyncio", "importlib", "io", "os", "pathlib", "pickle", "requests",
    "shutil", "socket", "subprocess", "sys", "tempfile", "threading",
}
# Underscore-prefixed C extension modules that grant the same dangerous
# capabilities as their public wrappers (network, subprocess, FFI, raw IO).
# We allow most internal modules through so Python's own import machinery can
# load user code, but these specific ones are escape hatches around the
# DENIED_IMPORT_ROOTS protections and must stay blocked.
DENIED_INTERNAL_IMPORT_ROOTS = {
    "_socket", "_ssl", "_ctypes", "_posixsubprocess", "_winapi",
    "_asyncio", "_multiprocessing", "_multibytecodec", "_pickle",
}
SAFE_IMPORT_ROOTS = {
    "abc", "array", "bisect", "collections", "copy", "dataclasses", "datetime",
    "decimal", "enum", "functools", "heapq", "itertools", "math", "numbers",
    "operator", "re", "typing",
}


@contextlib.contextmanager
def _strategy_runtime_guards():
    original_import = builtins.__import__
    original_open = builtins.open

    def guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = str(name).split(".", 1)[0]
        # CPython internal modules (underscore-prefixed like _io, _collections_abc,
        # _stat, _frozen_importlib, etc.) are imported by Python's own import
        # machinery when loading any .py file and can't be blocked wholesale
        # without breaking module loading. But a blanket allow would let user
        # strategies reach C extensions like _socket/_ssl/_ctypes that bypass the
        # network/FS/subprocess sandbox — so we allow internals EXCEPT the known
        # dangerous ones.
        if root.startswith("_"):
            if root in DENIED_INTERNAL_IMPORT_ROOTS:
                raise ImportError(f"Import {root!r} is not allowed in strict strategy runtime")
            return original_import(name, globals, locals, fromlist, level)
        if level == 0 and (root in DENIED_IMPORT_ROOTS or root not in SAFE_IMPORT_ROOTS):
            raise ImportError(f"Import {root!r} is not allowed in strict strategy runtime")
        return original_import(name, globals, locals, fromlist, level)

    def guarded_open(*args, **kwargs):
        raise PermissionError("Filesystem access is not allowed in strict strategy runtime")

    builtins.__import__ = guarded_import
    builtins.open = guarded_open
    try:
        yield
    finally:
        builtins.__import__ = original_import
        builtins.open = original_open


class WorkerBroker:
    MAX_ORDERS_PER_BAR = 100
    __slots__ = ("_state", "_history", "_orders")

    def __init__(self) -> None:
        self._state: Dict[str, Any] = {}
        self._history: Dict[str, Any] = {}
        self._orders: List[Dict[str, Any]] = []

    def begin_bar(self, state: Dict[str, Any], history: Dict[str, Any]) -> None:
        self._state = state
        self._history = history
        self._orders = []

    def drain_orders(self) -> List[Dict[str, Any]]:
        orders = self._orders
        self._orders = []
        return orders

    def _intent(self, side: str, symbol: str, qty: Optional[float] = None,
                notional: Optional[float] = None, tag: str = "") -> None:
        if len(self._orders) >= self.MAX_ORDERS_PER_BAR:
            raise RuntimeError(f"Too many orders in one bar; max is {self.MAX_ORDERS_PER_BAR}")
        if qty is not None and notional is not None:
            raise ValueError("Specify qty or notional, not both")
        rec: Dict[str, Any] = {"side": side, "symbol": str(symbol), "tag": str(tag)}
        if qty is not None:
            rec["qty"] = float(qty)
        if notional is not None:
            rec["notional"] = float(notional)
        self._orders.append(rec)

    def buy(self, symbol: str, qty: Optional[float] = None,
            notional: Optional[float] = None, tag: str = "") -> None:
        if qty is None and notional is None:
            notional = self.cash()
        self._intent("buy", symbol, qty=qty, notional=notional, tag=tag)

    def sell(self, symbol: str, qty: Optional[float] = None,
             notional: Optional[float] = None, tag: str = "") -> None:
        if qty is None and notional is None:
            qty = self.position(symbol)
        self._intent("sell", symbol, qty=qty, notional=notional, tag=tag)

    def position(self, symbol: str) -> float:
        return float(self._state.get("positions", {}).get(str(symbol), 0.0))

    def cash(self) -> float:
        return float(self._state.get("cash", 0.0))

    def equity(self) -> float:
        return float(self._state.get("equity", 0.0))

    def price(self, symbol: str) -> Optional[float]:
        px = self._state.get("prices", {}).get(str(symbol))
        return None if px is None else float(px)

    def history(self, symbol: str, limit: int = 100):
        rows = self._history.get(str(symbol), [])
        safe_limit = max(0, int(limit))
        view = rows[-safe_limit:] if safe_limit else []
        return tuple(MappingProxyType(dict(row)) for row in view)

    def greeks(self, symbol: str) -> Dict[str, float]:
        return dict(self._state.get("greeks", {}).get(str(symbol), {
            "delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "iv": 0.0,
        }))

    def underlying_price(self, symbol: str) -> Optional[float]:
        val = self._state.get("underlying_prices", {}).get(str(symbol))
        return None if val is None else float(val)

    def days_to_expiry(self, symbol: str) -> float:
        return float(self._state.get("dte", {}).get(str(symbol), float("inf")))


def _load_strategy(path: str):
    spec = importlib.util.spec_from_file_location("_finny_user_strategy", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot import strategy from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(Path(path).resolve().parent))
    with contextlib.redirect_stdout(sys.stderr), _strategy_runtime_guards():
        spec.loader.exec_module(module)
    cls = getattr(module, "Strategy", None)
    if cls is None:
        raise TypeError("Strict v2 requires `class Strategy`")
    sig = inspect.signature(cls.__init__)
    params = [p for p in sig.parameters if p != "self"]
    if not params or params[0] != "broker":
        raise TypeError("Strict v2 requires `Strategy(broker, params=None)`")
    on_bar = getattr(cls, "on_bar", None)
    if on_bar is None or not callable(on_bar):
        raise TypeError("Strict v2 requires `on_bar(self, symbol, bar)`")
    if getattr(cls, "on_tick", None) is not None:
        raise TypeError("Strict v2 rejects legacy `on_tick`; use `on_bar(self, symbol, bar)`")
    return cls, sig


def _instantiate(cls, sig, broker: WorkerBroker, params: Any):
    kwargs = {}
    if "params" in sig.parameters:
        kwargs["params"] = params
    with contextlib.redirect_stdout(sys.stderr), _strategy_runtime_guards():
        return cls(broker, **kwargs)


def _send(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, allow_nan=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strategy", required=True)
    ap.add_argument("--params-json", default="null")
    args = ap.parse_args()
    try:
        params = json.loads(args.params_json)
        broker = WorkerBroker()
        cls, sig = _load_strategy(args.strategy)
        strategy = _instantiate(cls, sig, broker, params)
        _send({"type": "ready"})
    except Exception as exc:
        _send({"type": "error", "message": str(exc), "trace": traceback.format_exc(limit=4)})
        return 1

    for line in sys.stdin:
        try:
            msg = json.loads(line)
            if msg.get("type") == "stop":
                _send({"type": "stopped"})
                return 0
            if msg.get("type") != "bar":
                raise ValueError("unknown worker message type")
            bar = MappingProxyType(dict(msg["bar"]))
            symbol = str(msg["symbol"])
            broker.begin_bar(dict(msg.get("state", {})), dict(msg.get("history", {})))
            with contextlib.redirect_stdout(sys.stderr), _strategy_runtime_guards():
                ret = strategy.on_bar(symbol, bar)
            if ret is not None:
                raise ValueError("on_bar must place broker intents and return None")
            _send({"type": "result", "orders": broker.drain_orders(), "diagnostics": {}})
        except Exception as exc:
            _send({"type": "error", "message": str(exc), "trace": traceback.format_exc(limit=4)})
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
