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

from ..core.arrays import MarketSnapshot
from ..assets import AssetSpec
from ..core.clock import interval_to_rule_and_bars_per_year
from ..execution.costs import CostConfig, borrow_charge_per_bar, funding_charge
from ..execution.fills import Fill, FillConfig, process_orders_for_bar
from ..portfolio.account import Account
from ..portfolio.liquidation import liquidation_price
from ..portfolio.positions import Position, PositionBook


class PortfolioBroker:
    def __init__(
        self,
        market: MarketSnapshot,
        account: Account,
        costs: CostConfig,
        fill_cfg: FillConfig,
        interval: str,
        asset_specs: Optional[Dict[str, AssetSpec]] = None,
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
        self.rejections: List[Dict[str, object]] = []
        self.interval = interval
        _, self.bars_per_year = interval_to_rule_and_bars_per_year(interval)
        # Funding cadence in bars
        bars_per_hour = self.bars_per_year / (365.0 * 24.0)
        self.funding_period_bars = max(1, int(round(costs.funding_interval_hours * bars_per_hour))) \
            if costs.funding_rate_bps_per_interval != 0 else 0
        self.bar_counter = 0

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
            "rejected_orders": len(self.rejections),
            "rejection_reasons": reasons,
            "rejections": list(self.rejections[-100:]),
            "pending_orders_at_end": len(self.orders),
        }

    # ---------- Runtime-facing API ----------

    def process_open(self, i: int) -> List[Fill]:
        """Fill queued orders at the decision-time-safe open and mark to open."""
        bar_fills: List[Fill] = []
        for sym in self.market.symbols:
            ba = self.market.arrays[sym]
            sym_orders = [o for o in self.orders if o.symbol == sym]
            fills = process_orders_for_bar(sym_orders, ba, i, self.costs, self.fill_cfg, self.asset_specs)
            for f in fills:
                self._apply_fill(f)
                bar_fills.append(f)
            # process_orders_for_bar mutates sym_orders in-place; sync back
            kept_ids = {o.id for o in sym_orders}
            self.orders = [o for o in self.orders if o.symbol != sym or o.id in kept_ids]

        open_prices = {sym: float(self.market.arrays[sym].open[i]) for sym in self.market.symbols}
        self.account.mark_prices(open_prices)
        return bar_fills

    def process_close(self, i: int, bar_fills: Optional[List[Fill]] = None) -> List[Fill]:
        """Mark to close, apply end-of-bar risk checks/costs, and log fills."""
        if bar_fills is None:
            bar_fills = []

        prices = {sym: float(self.market.arrays[sym].close[i]) for sym in self.market.symbols}
        self.account.mark_prices(prices)

        # Intra-bar liquidation check (using bar high/low) — only when
        # account is actually leveraged and maintenance threshold is set.
        if self.account.max_leverage > 1.0 and self.account.maintenance_margin_pct > 0.0:
            for sym, pos in list(self.book.positions.items()):
                if pos.qty == 0:
                    continue
                equity = self.get_equity()
                curr = prices[sym]
                liq = liquidation_price(pos, equity, curr, self.account.maintenance_margin_pct)
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

        self.bar_counter += 1
        self.fills_log.extend(bar_fills)
        return bar_fills

    def process_bar(self, i: int) -> List[Fill]:
        bar_fills = self.process_open(i)
        return self.process_close(i, bar_fills)

    # ---------- Internals ----------

    def _apply_fill(self, f: Fill) -> None:
        realized = self.book.apply_fill(
            symbol=f.symbol, side=f.side, qty=f.qty, price=f.price,
            fee=f.fee, ts_ns=f.ts_ns, tag=f.tag,
            stop_distance=f.stop_distance, liquidation=False,
            multiplier=self._multiplier(f.symbol),
        )
        self.account.apply_realized(realized)
        self.account.apply_fee(f.fee)

    def _reject(self, symbol: str, side: str, qty: Optional[float], reason: str) -> None:
        self.rejections.append({
            "bar_index": int(self.market.i),
            "symbol": symbol,
            "side": side,
            "qty": None if qty is None else float(qty),
            "reason": reason,
        })

    def _validate_order_for_queue(self, order) -> bool:
        symbol = str(getattr(order, "symbol", ""))
        side = str(getattr(order, "side", ""))
        qty = float(getattr(order, "qty", 0.0))
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
        volume = float(self.market.arrays[symbol].volume[self.market.i])
        if (spec is None or spec.volume_required) and (not np.isfinite(volume) or volume <= 0):
            self._reject(symbol, side, qty, "zero_volume_bar")
            return False
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
            queued_fee += abs(qqty * qprice * mult) * (self.costs.taker_fee_bps / 10_000.0)
        gross_after = 0.0
        for sym, projected in projected_qty.items():
            if projected == 0:
                continue
            gross_after += abs(projected) * self.latest_price(sym) * self._multiplier(sym)
        allowed = self.account.equity(self.book.positions) * self.account.max_leverage
        if gross_after + queued_fee > allowed + 1e-9:
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
        fee = abs(qty * fill_px * self._multiplier(symbol)) * (self.costs.taker_fee_bps / 10_000.0)
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

    def _apply_periodic_costs(self, i: int) -> None:
        # Funding for perp-style positions
        if self.funding_period_bars > 0 and (self.bar_counter + 1) % self.funding_period_bars == 0:
            for sym, pos in self.book.positions.items():
                if pos.qty == 0:
                    continue
                px = float(self.market.arrays[sym].close[i])
                notional = abs(pos.qty) * px * self._multiplier(sym)
                charge = funding_charge(notional, self.costs)
                amount = charge if pos.qty > 0 else -charge
                pos.funding_accum += amount
                self.account.apply_funding(amount)
        # Borrow on shorts every bar
        for sym, pos in self.book.positions.items():
            if pos.qty >= 0:
                continue
            px = float(self.market.arrays[sym].close[i])
            notional = abs(pos.qty) * px * self._multiplier(sym)
            charge = borrow_charge_per_bar(notional, self.costs, self.bars_per_year)
            if charge > 0:
                pos.borrow_accum += charge
                self.account.apply_funding(charge)

    def _multiplier(self, symbol: str) -> float:
        spec = self.asset_specs.get(symbol)
        return float(spec.multiplier) if spec is not None else 1.0
