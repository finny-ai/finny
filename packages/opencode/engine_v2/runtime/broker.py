"""PortfolioBroker — the v2 broker. Multi-symbol, shared cash + margin, queues
orders for next-bar processing.

Apply-fill flow:
  1. Strategy submits Order via submit_order(); queued.
  2. At next bar i, the runtime calls process_bar(i):
       a. Process queue against bar i (fills appended).
       b. Apply each fill to PositionBook (realize PnL on closes).
       c. Update Account cash (realized + fees + funding/borrow per-bar).
       d. Mark prices to bar close.
       e. Check intra-bar liquidation; if breached, force-close at liq px.
       f. Mark all positions to advance MAE/MFE tracking.
"""

from __future__ import annotations

import uuid
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from ..core.arrays import MarketSnapshot
from ..assets import AssetSpec
from ..options.symbols import is_option_symbol, parse_option_symbol
from ..options.pricing import option_price
from ..options.calendar import time_to_expiry_years
from ..core.clock import interval_to_rule_and_bars_per_year
from ..execution.costs import CostConfig, borrow_charge_per_bar, commission, funding_charge
from ..execution.fills import (
    Fill,
    FillConfig,
    ParticipationBudget,
    volume_forecast,
    process_intrabar_orders_for_bar,
    process_open_orders_for_bar,
    process_orders_for_bar,
)
from ..portfolio.account import Account
from ..portfolio.liquidation import liquidation_price
from ..portfolio.positions import Position, PositionBook
from ..execution.spread import half_spread
from .risk import RiskContract


class PortfolioBroker:
    def __init__(
        self,
        market: MarketSnapshot,
        account: Account,
        costs: CostConfig,
        fill_cfg: FillConfig,
        interval: str,
        asset_specs: Optional[Dict[str, AssetSpec]] = None,
        risk_contract: Optional[RiskContract] = None,
    ):
        self.market = market
        self.account = account
        self.asset_specs = asset_specs or {}
        self.account.asset_specs = self.asset_specs
        self.costs = costs
        self.fill_cfg = fill_cfg
        self.book = PositionBook()
        self.orders: List = []   # Order queue
        self.fills_log: List[Fill] = []
        self.order_log: List[Dict[str, object]] = []
        self.rejections: List[Dict[str, object]] = []
        self.buy_attempts = 0
        self.sell_attempts = 0
        self.interval = interval
        _, self.bars_per_year = interval_to_rule_and_bars_per_year(interval)
        self.bar_counter = 0
        self._last_cost_ts_ns: Optional[int] = None
        self._funding_elapsed_hours = 0.0
        self.halted = False
        self.dust_adjustments: List[Dict[str, object]] = []
        self._participation_budgets: Dict[str, ParticipationBudget] = {}
        self.risk_contract = risk_contract or RiskContract.legacy()
        if self.risk_contract.enforces_drawdown and self.fill_cfg.mode != "v2":
            raise ValueError("halt_and_flatten_next_open requires the strict v2 fill model")
        self._high_water_equity = float(self.get_equity())
        self.drawdown_trigger: Optional[Dict[str, object]] = None
        self._drawdown_liquidation_pending = False
        self._risk_sizing_events: List[Dict[str, object]] = []

    # ---------- Strategy-facing API ----------

    def submit_order(self, order) -> str:
        from ..execution.orders import Order
        if not isinstance(order, Order):
            raise TypeError("submit_order expects engine_v2.execution.orders.Order")
        if not self._validate_order_for_queue(order):
            return ""
        if order.id == "" or order.id is None:
            order.id = uuid.uuid4().hex
        order.qty_remaining = float(order.qty)
        order.bars_alive = 0
        self.orders.append(order)
        self._record_order_event("submitted", order=order)
        return order.id

    def submit_intent(
        self,
        *,
        side: str,
        symbol: str,
        qty: Optional[float] = None,
        notional: Optional[float] = None,
        tag: str = "",
    ) -> str:
        from ..execution.orders import Order

        if side == "buy":
            self.buy_attempts += 1
        elif side == "sell":
            self.sell_attempts += 1
        if side not in {"buy", "sell"}:
            self._reject(symbol, side, qty, "unsupported_side")
            return ""
        if symbol not in self.market.symbols:
            self._reject(symbol, side, qty, "symbol_mismatch")
            return ""
        px = self.latest_price(symbol)
        if not np.isfinite(px) or px <= 0:
            self._reject(symbol, side, qty, "invalid_decision_price")
            return ""
        if qty is not None and notional is not None:
            self._reject(symbol, side, qty, "qty_and_notional")
            return ""
        spec = self.asset_specs.get(symbol)
        if spec is not None and spec.assetClass == "future" and notional is not None:
            self._reject(symbol, side, qty, "futures_require_explicit_qty")
            return ""
        if notional is not None:
            if not np.isfinite(float(notional)) or float(notional) <= 0:
                self._reject(symbol, side, qty, "invalid_notional")
                return ""
            qty = float(notional) / (px * (spec.multiplier if spec is not None else 1.0))
        if qty is None:
            self._reject(symbol, side, qty, "missing_qty")
            return ""
        if not np.isfinite(float(qty)) or float(qty) <= 0:
            self._reject(symbol, side, qty, "invalid_qty")
            return ""
        order = Order(
            id=uuid.uuid4().hex,
            symbol=symbol,
            side=side,
            qty=float(qty),
            order_type="market",
            submitted_ts_ns=int(self.market.arrays[symbol].ts[self.market.i]),
            tag=tag,
        )
        return self.submit_order(order)

    def cancel_order(self, order_id: str) -> None:
        for order in self.orders:
            if order.id == order_id:
                self._record_order_event("canceled", order=order, reason="strategy_cancel")
        self.orders = [o for o in self.orders if o.id != order_id]

    def list_open_orders(self, symbol: Optional[str] = None) -> List:
        if symbol is None:
            return list(self.orders)
        return [o for o in self.orders if o.symbol == symbol]

    def get_position(self, symbol: str) -> Position:
        return self.book.get(symbol)

    def get_equity(self) -> float:
        return self.account.equity(self.book.positions)

    def latest_price(self, symbol: str) -> float:
        if getattr(self.market, "_decision_phase", False):
            return float(self.market.decision_price(symbol))
        return float(self.account.last_prices.get(symbol, self.market.last_close(symbol)))

    def diagnostics(self) -> Dict[str, object]:
        reasons: Dict[str, int] = {}
        for r in self.rejections:
            reason = str(r.get("reason", "unknown"))
            reasons[reason] = reasons.get(reason, 0) + 1
        return {
            "buy_attempts": self.buy_attempts,
            "sell_attempts": self.sell_attempts,
            "rejected_orders": len(self.rejections),
            "rejection_reasons": reasons,
            "rejections": list(self.rejections[-100:]),
            "pending_orders_at_end": len(self.orders),
            "halted": self.halted,
            "risk_contract": self.risk_contract.to_dict(),
            "risk_sizing_events": list(self._risk_sizing_events[-100:]),
            "risk_high_water_equity": self._high_water_equity,
            "drawdown_trigger": self.drawdown_trigger,
            "dust_adjustments": len(self.dust_adjustments),
        }

    def order_audit_rows(self) -> List[Dict[str, object]]:
        rows = list(self.order_log)
        for order in self.orders:
            rows.append(self._order_event_row("pending", order=order))
        return rows

    def terminal_liquidation_nav(self) -> Dict[str, object]:
        """Non-mutating liquidation-adjusted NAV at the current terminal mark.

        Pending orders are treated as canceled, then every open position is
        hypothetically closed with adverse terminal spread, slippage, and venue
        commission/contract fee. Funding and borrow accrued through elapsed bars
        are already reflected in account cash by the runtime.
        """
        nav = float(self.account.cash)
        closes: List[Dict[str, object]] = []
        for sym, pos in self.book.positions.items():
            if pos.qty == 0:
                continue
            spec = self.asset_specs.get(sym)
            ba = self.market.arrays[sym]
            px = float(self.account.last_prices.get(sym, ba.close[-1]))
            side = "sell" if pos.qty > 0 else "buy"
            qty = abs(float(pos.qty))
            slip = px * (float(self.fill_cfg.slippage.base_bps) / 10_000.0)
            close_win = ba.close[max(0, len(ba.close) - self.fill_cfg.spread.lookback_bars):]
            spr = half_spread(close_win, self.fill_cfg.spread, px)
            terminal_px = px - slip - spr if side == "sell" else px + slip + spr
            if spec is not None:
                terminal_px = spec.round_price(terminal_px)
            mult = self._multiplier(sym)
            realized = qty * (terminal_px - pos.avg_price) * (1 if pos.qty > 0 else -1) * mult
            fee = commission(
                abs(qty * terminal_px * mult),
                is_maker=False,
                cfg=self.costs,
                qty=qty,
                asset_class=spec.assetClass if spec is not None else "",
            )
            nav += realized - fee
            closes.append({
                "symbol": sym,
                "side": side,
                "qty": qty,
                "mark_price": px,
                "terminal_price": terminal_px,
                "realized_pnl": realized,
                "fee": fee,
                "funding_accrued": float(pos.funding_accum),
                "borrow_accrued": float(pos.borrow_accum),
            })
        return {
            "nav": nav,
            "canceled_pending_orders": len(self.orders),
            "hypothetical_closes": closes,
        }

    # ---------- Runtime-facing API ----------

    def _open_prices(self, i: int) -> Dict[str, float]:
        return {sym: float(self.market.arrays[sym].open[i]) for sym in self.market.symbols}

    def _process_open_symbol(self, sym: str, i: int, bar_fills: List[Fill]) -> None:
        ba = self.market.arrays[sym]
        self._participation_budgets[sym] = ParticipationBudget(
            forecast_volume=volume_forecast(ba, i),
            participation_pct=self.fill_cfg.participation_pct,
        )
        sym_orders = [o for o in self.orders if o.symbol == sym]
        fills = process_open_orders_for_bar(
            sym_orders, ba, i, self.costs, self.fill_cfg, self.asset_specs,
            participation_budget=self._participation_budgets[sym],
            margin_check=self._margin_cap_at_fill,
            on_expire=self._record_ttl_expired,
        )
        for f in fills:
            self._apply_fill(f)
            bar_fills.append(f)
        kept_ids = {o.id for o in sym_orders}
        self.orders = [o for o in self.orders if o.symbol != sym or o.id in kept_ids]
        self._settle_dust(sym, i)

    def _process_open_halted(self, i: int) -> List[Fill]:
        if not self._drawdown_liquidation_pending:
            return []
        bar_fills = self._execute_drawdown_flatten(i)
        self.account.mark_prices(self._open_prices(i))
        self._check_insolvency(i)
        return bar_fills

    def process_open(self, i: int) -> List[Fill]:
        """Fill queued market orders at the decision-time-safe open and mark to open."""
        if self.halted:
            return self._process_open_halted(i)
        bar_fills: List[Fill] = []
        self._participation_budgets = {}
        for sym in self.market.symbols:
            self._process_open_symbol(sym, i, bar_fills)
        self.account.mark_prices(self._open_prices(i))
        self._check_insolvency(i)
        return bar_fills

    def process_intrabar(self, i: int) -> List[Fill]:
        """Process limit/stop/trailing orders using current-bar OHLC after decision."""
        if self.halted:
            return []
        bar_fills: List[Fill] = []
        for sym in self.market.symbols:
            ba = self.market.arrays[sym]
            sym_orders = [o for o in self.orders if o.symbol == sym]
            budget = self._participation_budgets.get(sym)
            fills = process_intrabar_orders_for_bar(
                sym_orders, ba, i, self.costs, self.fill_cfg, self.asset_specs,
                participation_budget=budget,
                margin_check=self._margin_cap_at_fill,
                on_expire=self._record_ttl_expired,
            )
            for f in fills:
                self._apply_fill(f)
                bar_fills.append(f)
            kept_ids = {o.id for o in sym_orders}
            self.orders = [o for o in self.orders if o.symbol != sym or o.id in kept_ids]
            self._settle_dust(sym, i)
        self._check_insolvency(i)
        return bar_fills

    def process_close(self, i: int, bar_fills: Optional[List[Fill]] = None) -> List[Fill]:
        """Mark to close, apply end-of-bar risk checks/costs, and log fills."""
        if bar_fills is None:
            bar_fills = []

        prices = {sym: float(self.market.arrays[sym].close[i]) for sym in self.market.symbols}

        # Option mark-to-model: re-price options via BS before marking.
        # This naturally captures theta decay and delta P&L.
        expiry_fills = self._apply_option_marks(i, prices)
        bar_fills.extend(expiry_fills)

        self.account.mark_prices(prices)

        # Intra-bar liquidation check (using bar high/low) — only when
        # account is actually leveraged and maintenance threshold is set.
        if self.account.max_leverage > 1.0 and self.account.maintenance_margin_pct > 0.0:
            for sym, pos in list(self.book.positions.items()):
                if pos.qty == 0:
                    continue
                equity = self.get_equity()
                curr = prices[sym]
                liq = liquidation_price(pos, equity, curr, self.account.maintenance_margin_pct_for_symbol(sym))
                if liq is None:
                    continue
                ba = self.market.arrays[sym]
                low = float(ba.low[i])
                high = float(ba.high[i])
                breached = (pos.qty > 0 and low <= liq) or (pos.qty < 0 and high >= liq)
                if breached:
                    liq_fill = self._liquidate(sym, liq, i)
                    if liq_fill is not None:
                        bar_fills.append(liq_fill)

        self._apply_periodic_costs(i)

        self.book.mark_all(prices)
        self._enforce_drawdown_contract(i)

        self.bar_counter += 1
        self.fills_log.extend(bar_fills)
        return bar_fills

    def process_bar(self, i: int) -> List[Fill]:
        bar_fills = self.process_open(i)
        bar_fills.extend(self.process_intrabar(i))
        return self.process_close(i, bar_fills)

    # ---------- Internals ----------

    def _fill_time_prices(self, fill_symbol: str, fill_price: float) -> Dict[str, float]:
        """Mark all symbols to the current bar open, overriding the fill symbol."""
        i = self.market.i
        return {
            sym: float(fill_price if sym == fill_symbol else self.market.arrays[sym].open[i])
            for sym in self.market.symbols
        }

    def _equity_at_prices(self, prices: Dict[str, float]) -> float:
        unrealized = 0.0
        for sym, pos in self.book.positions.items():
            if pos.qty == 0:
                continue
            px = float(prices.get(sym, pos.avg_price))
            unrealized += pos.qty * (px - pos.avg_price) * self._multiplier(sym)
        return self.account.cash + unrealized

    def _margin_cap_at_fill(self, order, qty: float, price: float) -> float:
        """Recheck buying power at the actual fill price; return affordable qty."""
        if qty <= 0:
            return 0.0
        sym = str(order.symbol)
        side = str(order.side)
        spec = self.asset_specs.get(sym)
        mult = spec.multiplier if spec is not None else 1.0
        asset_class = spec.assetClass if spec is not None else ""
        fill_prices = self._fill_time_prices(sym, float(price))
        projected_qty: Dict[str, float] = {s: float(p.qty) for s, p in self.book.positions.items()}
        for s in self.market.symbols:
            projected_qty.setdefault(s, 0.0)
        delta = qty if side == "buy" else -qty
        projected_qty[sym] = projected_qty.get(sym, 0.0) + delta
        fee = commission(abs(qty * price * mult), is_maker=False, cfg=self.costs, qty=qty, asset_class=asset_class)
        required = self.account.required_initial_margin_for_quantities(projected_qty, fill_prices) + fee
        allowed = self._equity_at_prices(fill_prices)
        if required <= allowed + 1e-9:
            return qty
        lo, hi = 0.0, qty
        for _ in range(40):
            mid = (lo + hi) / 2.0
            if mid <= 0:
                break
            test_qty = mid
            test_delta = test_qty if side == "buy" else -test_qty
            test_proj = dict(projected_qty)
            test_proj[sym] = test_proj.get(sym, 0.0) - delta + test_delta
            test_fee = commission(
                abs(test_qty * price * mult), is_maker=False, cfg=self.costs,
                qty=test_qty, asset_class=asset_class,
            )
            test_required = self.account.required_initial_margin_for_quantities(test_proj, fill_prices) + test_fee
            if test_required <= allowed + 1e-9:
                lo = mid
            else:
                hi = mid
        if spec is not None:
            return spec.round_qty(lo)
        return lo

    def _check_insolvency(self, i: int) -> None:
        if self.get_equity() <= 0.0:
            self.halted = True
            for order in self.orders:
                self._record_order_event("canceled", order=order, reason="insolvency_halt")
            self.orders.clear()

    def _enforce_drawdown_contract(self, i: int) -> None:
        equity = float(self.get_equity())
        if np.isfinite(equity) and equity > self._high_water_equity:
            self._high_water_equity = equity
        if not self.risk_contract.enforces_drawdown or self.drawdown_trigger is not None:
            return
        limit_pct = self.risk_contract.drawdown_limit_pct
        if limit_pct is None or self._high_water_equity <= 0 or not np.isfinite(equity):
            return
        drawdown_pct = max(0.0, (self._high_water_equity - equity) / self._high_water_equity * 100.0)
        if drawdown_pct + 1e-12 < limit_pct:
            return

        canceled = len(self.orders)
        for order in self.orders:
            self._record_order_event("canceled", order=order, reason="drawdown_halt")
        self.orders.clear()
        open_symbols = [symbol for symbol, pos in self.book.positions.items() if abs(float(pos.qty)) > 1e-12]
        self.halted = True
        self._drawdown_liquidation_pending = bool(open_symbols)
        symbol = open_symbols[0] if open_symbols else next(iter(self.market.symbols), None)
        ts_ns = self._current_ts_ns(symbol)
        self.drawdown_trigger = {
            "bar_index": int(i),
            "ts_ns": ts_ns,
            "high_water_equity": float(self._high_water_equity),
            "equity": equity,
            "drawdown_pct": drawdown_pct,
            "limit_pct": float(limit_pct),
            "canceled_pending_orders": canceled,
            "flatten_symbols": open_symbols,
            "flatten_status": "scheduled" if open_symbols else "not_required",
            "flatten_execution_bar": None,
            "flatten_execution_ts_ns": None,
            "flatten_fill_count": 0,
            "flatten_fees": 0.0,
        }

    def _flatten_position_at_open(self, i: int, symbol: str, pos) -> List[Fill]:
        from ..execution.orders import Order

        qty = abs(float(pos.qty))
        if qty <= 1e-12:
            return []
        side = "sell" if pos.qty > 0 else "buy"
        ba = self.market.arrays[symbol]
        order = Order(
            id=f"drawdown-{i}-{symbol}-{uuid.uuid4().hex[:8]}",
            symbol=symbol,
            side=side,
            qty=qty,
            order_type="market",
            submitted_ts_ns=int(ba.ts[i]),
            tag="DRAWDOWN_FLATTEN",
        )
        self._record_order_event("submitted", order=order, reason="drawdown_flatten")
        risk_fills = process_open_orders_for_bar(
            [order],
            ba,
            i,
            self.costs,
            self.fill_cfg,
            self.asset_specs,
            participation_budget=ParticipationBudget.unlimited(volume_forecast(ba, i)),
            margin_check=None,
            on_expire=None,
        )
        for fill in risk_fills:
            self._apply_fill(fill)
        return risk_fills

    def _record_flatten_outcome(self, i: int, fills: List[Fill], remaining: List[str]) -> None:
        if self.drawdown_trigger is None:
            return
        self.drawdown_trigger["flatten_execution_bar"] = int(i)
        first_symbol = next(iter(self.market.symbols), None)
        self.drawdown_trigger["flatten_execution_ts_ns"] = self._current_ts_ns(first_symbol)
        self.drawdown_trigger["flatten_fill_count"] = len(fills)
        self.drawdown_trigger["flatten_fees"] = float(sum(fill.fee for fill in fills))
        self.drawdown_trigger["flatten_status"] = "partial" if remaining else "completed"
        self.drawdown_trigger["remaining_symbols"] = remaining

    def _execute_drawdown_flatten(self, i: int) -> List[Fill]:
        """Force-close the triggered book at the next open using normal costs.

        The risk liquidation bypasses the participation cap so a configured
        volume throttle cannot leave exposure behind after a hard halt. Price,
        slippage, spread, asset rounding, and commission all use the ordinary
        v2 open-fill path.
        """
        if not self._drawdown_liquidation_pending:
            return []
        fills: List[Fill] = []
        for symbol, pos in list(self.book.positions.items()):
            fills.extend(self._flatten_position_at_open(i, symbol, pos))

        remaining = [symbol for symbol, pos in self.book.positions.items() if abs(float(pos.qty)) > 1e-12]
        self._drawdown_liquidation_pending = bool(remaining)
        self._record_flatten_outcome(i, fills, remaining)
        return fills

    def _settle_dust(self, symbol: str, i: int) -> None:
        """Close sub-lot residuals below venue precision without re-queueing orders."""
        spec = self.asset_specs.get(symbol)
        if spec is None:
            return
        pos = self.book.get(symbol)
        if pos.qty == 0:
            return
        if spec.round_qty(abs(pos.qty)) > 0:
            return
        px = self.latest_price(symbol)
        if not np.isfinite(px) or px <= 0:
            return
        side = "sell" if pos.qty > 0 else "buy"
        qty = abs(pos.qty)
        fee = 0.0
        realized = self.book.apply_fill(
            symbol=symbol, side=side, qty=qty, price=px,
            fee=fee, ts_ns=int(self.market.arrays[symbol].ts[i]), tag="DUST",
            stop_distance=None, liquidation=False, multiplier=self._multiplier(symbol),
        )
        self.account.apply_realized(realized)
        self.dust_adjustments.append({
            "bar_index": i, "symbol": symbol, "qty": qty, "price": px, "realized": realized,
        })

    def _record_ttl_expired(self, order) -> None:
        self._record_order_event("canceled", order=order, reason="ttl_expired")

    def _apply_fill(self, f: Fill) -> None:
        realized = self.book.apply_fill(
            symbol=f.symbol, side=f.side, qty=f.qty, price=f.price,
            fee=f.fee, ts_ns=f.ts_ns, tag=f.tag,
            stop_distance=f.stop_distance, liquidation=False,
            multiplier=self._multiplier(f.symbol),
        )
        self.account.apply_realized(realized)
        self.account.apply_fee(f.fee)
        self._record_order_event("filled" if f.full else "partial", fill=f)

    def _reject(self, symbol: str, side: str, qty: Optional[float], reason: str) -> None:
        self.rejections.append({
            "bar_index": int(self.market.i),
            "symbol": symbol,
            "side": side,
            "qty": None if qty is None else float(qty),
            "reason": reason,
        })
        self._record_order_event("rejected", symbol=symbol, side=side, qty=qty, reason=reason)

    def _current_ts_ns(self, symbol: Optional[str]) -> Optional[int]:
        if not symbol or symbol not in self.market.arrays:
            return None
        ba = self.market.arrays[symbol]
        if self.market.i < 0 or self.market.i >= len(ba.ts):
            return None
        return int(ba.ts[self.market.i])

    def _order_event_row(
        self,
        status: str,
        *,
        order=None,
        fill: Optional[Fill] = None,
        symbol: Optional[str] = None,
        side: Optional[str] = None,
        qty: Optional[float] = None,
        reason: Optional[str] = None,
    ) -> Dict[str, object]:
        if fill is not None:
            ts_ns: Optional[int] = int(fill.ts_ns)
            return {
                "bar_index": int(fill.bar_index),
                "ts": str(pd.Timestamp(ts_ns, unit="ns", tz="UTC")),
                "ts_ns": ts_ns,
                "order_id": fill.order_id,
                "symbol": fill.symbol,
                "side": fill.side,
                "qty": float(fill.qty),
                "qty_remaining": 0.0 if fill.full else None,
                "order_type": "",
                "status": status,
                "price": float(fill.price),
                "fee": float(fill.fee),
                "tag": fill.tag,
                "reason": reason or "",
            }
        if order is not None:
            symbol = str(getattr(order, "symbol", symbol or ""))
            ts_ns = self._current_ts_ns(symbol)
            return {
                "bar_index": int(self.market.i),
                "ts": str(pd.Timestamp(ts_ns, unit="ns", tz="UTC")) if ts_ns is not None else "",
                "ts_ns": ts_ns,
                "order_id": str(getattr(order, "id", "")),
                "symbol": symbol,
                "side": str(getattr(order, "side", side or "")),
                "qty": float(getattr(order, "qty", qty or 0.0)),
                "qty_remaining": float(getattr(order, "qty_remaining", 0.0)),
                "order_type": str(getattr(order, "order_type", "")),
                "status": status,
                "price": "",
                "fee": "",
                "tag": str(getattr(order, "tag", "")),
                "reason": reason or "",
            }
        ts_ns = self._current_ts_ns(symbol)
        return {
            "bar_index": int(self.market.i),
            "ts": str(pd.Timestamp(ts_ns, unit="ns", tz="UTC")) if ts_ns is not None else "",
            "ts_ns": ts_ns,
            "order_id": "",
            "symbol": symbol or "",
            "side": side or "",
            "qty": None if qty is None else float(qty),
            "qty_remaining": "",
            "order_type": "",
            "status": status,
            "price": "",
            "fee": "",
            "tag": "",
            "reason": reason or "",
        }

    def _record_order_event(self, status: str, **kwargs) -> None:
        self.order_log.append(self._order_event_row(status, **kwargs))

    def _projected_qty_before_order(self, symbol: str) -> float:
        projected = float(self.book.get(symbol).qty)
        for queued in self.orders:
            if str(getattr(queued, "symbol", "")) != symbol:
                continue
            side = str(getattr(queued, "side", ""))
            remaining = float(
                getattr(queued, "qty_remaining", 0.0)
                or getattr(queued, "qty", 0.0)
            )
            if side == "buy":
                projected += remaining
            elif side == "sell":
                projected -= remaining
        return projected

    def _enforce_contract_sizing(self, order, qty: float, price: float) -> Optional[float]:
        """Apply the schema-v4 stop-distance sizing boundary to new exposure.

        Reductions and full closes are never blocked.  New or increased
        exposure is capped so its declared stop-distance loss fits within one
        position slot's share of the portfolio drawdown budget.
        """
        stop_distance = self.risk_contract.stop_distance_for_price(price)
        if stop_distance is None:
            return qty

        symbol = str(order.symbol)
        side = str(order.side)
        direction = 1.0 if side == "buy" else -1.0
        before = self._projected_qty_before_order(symbol)
        after = before + direction * qty
        flips_side = before * after < -1e-12
        increases_exposure = abs(after) > abs(before) + 1e-12
        if not flips_side and not increases_exposure:
            return qty

        spec = self.asset_specs.get(symbol)
        multiplier = float(spec.multiplier) if spec is not None else 1.0
        equity = float(self.get_equity())
        max_qty = self.risk_contract.max_position_qty(
            equity=equity,
            price=price,
            multiplier=multiplier,
        )
        if max_qty is None or not np.isfinite(max_qty) or max_qty <= 0:
            self._reject(symbol, side, qty, "risk_sizing_unavailable")
            return None

        accepted_qty = qty
        if abs(after) > max_qty + 1e-12:
            # Final quantity at the order-side boundary is +max_qty for buys
            # and -max_qty for sells.  This formula also handles a side flip.
            accepted_qty = max(0.0, max_qty - direction * before)
            if spec is not None:
                accepted_qty = spec.round_qty(accepted_qty)
            if accepted_qty <= 1e-12:
                self._reject(symbol, side, qty, "risk_sizing_limit")
                return None

        order.stop_distance_hint = float(stop_distance)
        order.qty = float(accepted_qty)
        order.qty_remaining = float(accepted_qty)
        self._risk_sizing_events.append({
            "bar_index": int(self.market.i),
            "symbol": symbol,
            "side": side,
            "requested_qty": float(qty),
            "accepted_qty": float(accepted_qty),
            "projected_qty_before": float(before),
            "max_position_qty": float(max_qty),
            "decision_price": float(price),
            "stop_distance": float(stop_distance),
            "risk_budget_pct_per_position": self.risk_contract.risk_budget_pct_per_position,
            "status": "constrained" if accepted_qty + 1e-12 < qty else "derived",
        })
        return float(accepted_qty)

    # @codescene(disable-all) Queue validation centralizes the broker safety contract.
    def _validate_order_for_queue(self, order) -> bool:
        symbol = str(getattr(order, "symbol", ""))
        side = str(getattr(order, "side", ""))
        qty = float(getattr(order, "qty", 0.0))
        if self.halted:
            reason = "drawdown_halt" if self.drawdown_trigger is not None else "insolvency_halt"
            self._reject(symbol, side, qty, reason)
            return False
        if symbol not in self.market.symbols:
            self._reject(symbol, side, qty, "symbol_mismatch")
            return False
        if side not in {"buy", "sell"}:
            self._reject(symbol, side, qty, "unsupported_side")
            return False
        if not np.isfinite(qty) or qty <= 0:
            self._reject(symbol, side, qty, "invalid_qty")
            return False
        spec = self.asset_specs.get(symbol)
        if spec is not None:
            rounded = spec.round_qty(qty)
            if rounded <= 0:
                self._reject(symbol, side, qty, "below_lot_size")
                return False
            order.qty = rounded
            order.qty_remaining = rounded
            qty = rounded
        price = self.latest_price(symbol)
        if not np.isfinite(price) or price <= 0:
            self._reject(symbol, side, qty, "invalid_decision_price")
            return False
        # Liquidity gate uses the most recent *settled* bar's volume as a
        # forecast (no lookahead). On the very first bar there is no prior
        # volume to forecast from — allow the order through; the fill engine
        # still refuses to fill on a zero-volume fill bar, so a genuinely
        # illiquid bar produces no fill rather than a spurious submission reject.
        prev_i = self.market.i - 1
        if prev_i >= 0:
            volume = float(self.market.arrays[symbol].volume[prev_i])
            if (spec is None or spec.volume_required) and (not np.isfinite(volume) or volume <= 0):
                self._reject(symbol, side, qty, "zero_volume_bar")
                return False
        constrained_qty = self._enforce_contract_sizing(order, qty, price)
        if constrained_qty is None:
            return False
        qty = constrained_qty
        # Participation is enforced by the fill engine as partial fills. Do not
        # reject larger parent orders here; the unfilled remainder carries until
        # filled or TTL-expired. Margin, however, must be checked against the
        # aggregate queued book so a strategy cannot split one oversized parent
        # order into many individually-acceptable orders on the same bar.
        projected_qty: Dict[str, float] = {sym: float(pos.qty) for sym, pos in self.book.positions.items()}
        for sym in self.market.symbols:
            projected_qty.setdefault(sym, 0.0)
        queued_fee = 0.0
        for queued in [*self.orders, order]:
            qsym = str(getattr(queued, "symbol", ""))
            qside = str(getattr(queued, "side", ""))
            qqty = float(getattr(queued, "qty_remaining", 0.0) or getattr(queued, "qty", 0.0))
            if qsym not in self.market.symbols or qside not in {"buy", "sell"} or not np.isfinite(qqty) or qqty <= 0:
                continue
            qprice = self.latest_price(qsym)
            projected_qty[qsym] = projected_qty.get(qsym, 0.0) + (qqty if qside == "buy" else -qqty)
            qspec = self.asset_specs.get(qsym)
            mult = qspec.multiplier if qspec is not None else 1.0
            queued_fee += commission(
                abs(qqty * qprice * mult),
                is_maker=False,
                cfg=self.costs,
                qty=qqty,
                asset_class=qspec.assetClass if qspec is not None else "",
            )
        projected_prices = {sym: self.latest_price(sym) for sym in projected_qty}
        max_positions = self.risk_contract.max_positions
        if max_positions is not None:
            projected_open_positions = sum(1 for value in projected_qty.values() if abs(value) > 1e-12)
            if projected_open_positions > max_positions:
                self._reject(symbol, side, qty, "max_positions")
                return False
        required_margin = self.account.required_initial_margin_for_quantities(projected_qty, projected_prices)
        allowed = self.account.equity(self.book.positions)
        if required_margin + queued_fee > allowed + 1e-9:
            self._reject(symbol, side, qty, "insufficient_margin")
            return False
        return True

    def _liquidate(self, symbol: str, liq_px: float, i: int) -> Optional[Fill]:
        pos = self.book.get(symbol)
        if pos.qty == 0:
            return None
        side = "sell" if pos.qty > 0 else "buy"
        qty = abs(pos.qty)
        # Adverse slip on the wrong side: use base bps as worst-case extra.
        slip = liq_px * (self.fill_cfg.slippage.base_bps / 10_000.0)
        fill_px = liq_px - slip if side == "sell" else liq_px + slip
        spec = self.asset_specs.get(symbol)
        fee = commission(
            abs(qty * fill_px * self._multiplier(symbol)),
            is_maker=False,
            cfg=self.costs,
            qty=qty,
            asset_class=spec.assetClass if spec is not None else "",
        )
        realized = self.book.apply_fill(
            symbol=symbol, side=side, qty=qty, price=fill_px,
            fee=fee, ts_ns=int(self.market.arrays[symbol].ts[i]), tag="LIQUIDATION",
            stop_distance=None, liquidation=True, multiplier=self._multiplier(symbol),
        )
        self.account.apply_realized(realized)
        self.account.apply_fee(fee)
        # Surface liquidation as a Fill so process_bar() callers see the
        # complete bar fill set, not just routed-order fills. The caller
        # appends this into bar_fills which is then extended into
        # self.fills_log — we do NOT append here, to avoid double-counting.
        return Fill(
            order_id="LIQ", symbol=symbol, side=side, qty=qty, price=fill_px,
            fee=fee, bar_index=i, ts_ns=int(self.market.arrays[symbol].ts[i]),
            tag="LIQUIDATION", is_maker=False, full=True, stop_distance=None,
        )

    # ---------- Options: strategy-facing ----------

    def greeks(self, symbol: str) -> Dict[str, float]:
        ba = self.market.arrays.get(symbol)
        if ba is None:
            return {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "iv": 0.0}
        i = max(self.market.i - 1, 0) if self.market._decision_phase else self.market.i
        spec = self.asset_specs.get(symbol)
        if spec is not None and spec.assetClass == "option" and ba.delta is not None:
            return {
                "delta": float(ba.delta[i]),
                "gamma": float(ba.gamma[i]),
                "theta": float(ba.theta[i]),
                "vega": float(ba.vega[i]),
                "iv": float(ba.iv[i]) if ba.iv is not None else 0.0,
            }
        return {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "iv": 0.0}

    def underlying_price(self, symbol: str) -> Optional[float]:
        ba = self.market.arrays.get(symbol)
        if ba is None:
            return None
        i = max(self.market.i - 1, 0) if self.market._decision_phase else self.market.i
        if ba.underlying_close is not None:
            return float(ba.underlying_close[i])
        if is_option_symbol(symbol):
            opt = parse_option_symbol(symbol)
            und_ba = self.market.arrays.get(opt.underlying)
            if und_ba is not None:
                return float(und_ba.close[i])
        return None

    def days_to_expiry(self, symbol: str) -> float:
        # Calendar days to expiry, matching live IBKRBroker.days_to_expiry()
        # semantics. (Trading-day count is used internally for BS pricing via
        # time_to_expiry_years(use_trading_days=True), but the strategy-facing
        # value here is calendar days so backtest and live agree.)
        if not is_option_symbol(symbol):
            return float("inf")
        opt = parse_option_symbol(symbol)
        ts_ns = int(self.market.arrays[symbol].ts[self.market.i])
        return time_to_expiry_years(opt.expiry, ts_ns, use_trading_days=False) * 365.0

    # ---------- Options: internal ----------

    def _apply_option_marks(self, i: int, prices: Dict[str, float]) -> List[Fill]:
        """Re-price open option positions via BS mark-to-model. Handles expiry."""
        expiry_fills: List[Fill] = []
        for sym, pos in list(self.book.positions.items()):
            if pos.qty == 0:
                continue
            spec = self.asset_specs.get(sym)
            if spec is None or spec.assetClass != "option":
                continue
            if not is_option_symbol(sym):
                continue

            opt = parse_option_symbol(sym)
            ba = self.market.arrays[sym]
            ts_ns = int(ba.ts[i])
            T = time_to_expiry_years(opt.expiry, ts_ns)

            # Resolve underlying price
            S = None
            if ba.underlying_close is not None:
                S = float(ba.underlying_close[i])
            else:
                und_ba = self.market.arrays.get(opt.underlying)
                if und_ba is not None:
                    S = float(und_ba.close[i])
            if S is None:
                continue

            if T <= 0:
                fill = self._handle_expiry(sym, pos, opt, S, i)
                if fill is not None:
                    expiry_fills.append(fill)
                continue

            iv_val = float(ba.iv[i]) if ba.iv is not None else 0.25
            model_price = option_price(S, opt.strike, T, 0.05, iv_val, opt.right)
            model_price = max(model_price, 0.0)
            prices[sym] = model_price

        return expiry_fills

    def _handle_expiry(self, sym: str, pos, opt, underlying_price: float, i: int) -> Optional[Fill]:
        """Exercise ITM or expire OTM at expiry."""
        K = opt.strike
        is_itm = (opt.is_call and underlying_price > K) or (opt.is_put and underlying_price < K)

        if is_itm:
            exercise_val = abs(underlying_price - K)
            tag = "EXERCISE"
        else:
            exercise_val = 0.0
            tag = "EXPIRY"

        side = "sell" if pos.qty > 0 else "buy"
        qty = abs(pos.qty)
        fill_price = exercise_val
        mult = self._multiplier(sym)
        fee = abs(qty) * self.costs.option_per_contract_fee if self.costs.option_per_contract_fee > 0 else 0.0

        realized = self.book.apply_fill(
            symbol=sym, side=side, qty=qty, price=fill_price,
            fee=fee, ts_ns=int(self.market.arrays[sym].ts[i]), tag=tag,
            stop_distance=None, liquidation=False, multiplier=mult,
        )
        self.account.apply_realized(realized)
        self.account.apply_fee(fee)

        return Fill(
            order_id=tag, symbol=sym, side=side, qty=qty, price=fill_price,
            fee=fee, bar_index=i, ts_ns=int(self.market.arrays[sym].ts[i]),
            tag=tag, is_maker=False, full=True, stop_distance=None,
        )

    def _apply_periodic_costs(self, i: int) -> None:
        ts_ns = int(next(iter(self.market.arrays.values())).ts[i])
        if self._last_cost_ts_ns is None:
            self._last_cost_ts_ns = ts_ns
            return
        elapsed_years = max(0.0, (ts_ns - self._last_cost_ts_ns) / (365.25 * 86_400_000_000_000.0))
        elapsed_hours = elapsed_years * 365.25 * 24.0
        self._last_cost_ts_ns = ts_ns
        # Funding for perp-style positions
        funding_intervals = 0
        if self.costs.funding_rate_bps_per_interval != 0 and self.costs.funding_interval_hours > 0:
            self._funding_elapsed_hours += elapsed_hours
            funding_intervals = int(self._funding_elapsed_hours // self.costs.funding_interval_hours)
            if funding_intervals > 0:
                self._funding_elapsed_hours -= funding_intervals * self.costs.funding_interval_hours
        if funding_intervals > 0:
            for sym, pos in self.book.positions.items():
                if pos.qty == 0:
                    continue
                px = float(self.market.arrays[sym].close[i])
                notional = abs(pos.qty) * px * self._multiplier(sym)
                charge = funding_charge(notional, self.costs) * funding_intervals
                amount = charge if pos.qty > 0 else -charge
                pos.funding_accum += amount
                self.account.apply_funding(amount)
        # Borrow on shorts every bar
        for sym, pos in self.book.positions.items():
            if pos.qty >= 0:
                continue
            px = float(self.market.arrays[sym].close[i])
            notional = abs(pos.qty) * px * self._multiplier(sym)
            charge = notional * self.costs.short_borrow_rate_annual * elapsed_years
            if charge > 0:
                pos.borrow_accum += charge
                self.account.apply_funding(charge)

    def _multiplier(self, symbol: str) -> float:
        spec = self.asset_specs.get(symbol)
        return float(spec.multiplier) if spec is not None else 1.0
