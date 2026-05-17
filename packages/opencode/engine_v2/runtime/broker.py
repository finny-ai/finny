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
    ):
        self.market = market
        self.account = account
        self.costs = costs
        self.fill_cfg = fill_cfg
        self.book = PositionBook()
        self.orders: List = []   # Order queue
        self.fills_log: List[Fill] = []
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
        if order.id == "" or order.id is None:
            order.id = uuid.uuid4().hex
        order.qty_remaining = float(order.qty)
        order.bars_alive = 0
        self.orders.append(order)
        return order.id

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
        return float(self.account.last_prices.get(symbol, self.market.last_close(symbol)))

    # ---------- Runtime-facing API ----------

    def process_bar(self, i: int) -> List[Fill]:
        # 1. Process queued orders per-symbol against bar i.
        bar_fills: List[Fill] = []
        for sym in self.market.symbols:
            ba = self.market.arrays[sym]
            sym_orders = [o for o in self.orders if o.symbol == sym]
            fills = process_orders_for_bar(sym_orders, ba, i, self.costs, self.fill_cfg)
            for f in fills:
                self._apply_fill(f)
                bar_fills.append(f)
            # process_orders_for_bar mutates sym_orders in-place; sync back
            kept_ids = {o.id for o in sym_orders}
            self.orders = [o for o in self.orders if o.symbol != sym or o.id in kept_ids]

        # 2. Mark all symbols to bar close.
        prices = {sym: float(self.market.arrays[sym].close[i]) for sym in self.market.symbols}
        self.account.mark_prices(prices)

        # 3. Intra-bar liquidation check (using bar high/low) — only when
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
                    self._liquidate(sym, liq, i)

        # 4. Funding / borrow charges per bar.
        self._apply_periodic_costs(i)

        # 5. Mark positions for MAE/MFE.
        self.book.mark_all(prices)

        self.bar_counter += 1
        self.fills_log.extend(bar_fills)
        return bar_fills

    # ---------- Internals ----------

    def _apply_fill(self, f: Fill) -> None:
        realized = self.book.apply_fill(
            symbol=f.symbol, side=f.side, qty=f.qty, price=f.price,
            fee=f.fee, ts_ns=f.ts_ns, tag=f.tag,
            stop_distance=f.stop_distance, liquidation=False,
        )
        self.account.apply_realized(realized)
        self.account.apply_fee(f.fee)

    def _liquidate(self, symbol: str, liq_px: float, i: int) -> None:
        pos = self.book.get(symbol)
        if pos.qty == 0:
            return
        side = "sell" if pos.qty > 0 else "buy"
        qty = abs(pos.qty)
        # Adverse slip on the wrong side: use base bps as worst-case extra.
        slip = liq_px * (self.fill_cfg.slippage.base_bps / 10_000.0)
        fill_px = liq_px - slip if side == "sell" else liq_px + slip
        fee = abs(qty * fill_px) * (self.costs.taker_fee_bps / 10_000.0)
        realized = self.book.apply_fill(
            symbol=symbol, side=side, qty=qty, price=fill_px,
            fee=fee, ts_ns=int(self.market.arrays[symbol].ts[i]), tag="LIQUIDATION",
            stop_distance=None, liquidation=True,
        )
        self.account.apply_realized(realized)
        self.account.apply_fee(fee)
        # Also log it as a Fill for diagnostics
        self.fills_log.append(Fill(
            order_id="LIQ", symbol=symbol, side=side, qty=qty, price=fill_px,
            fee=fee, bar_index=i, ts_ns=int(self.market.arrays[symbol].ts[i]),
            tag="LIQUIDATION", is_maker=False, full=True, stop_distance=None,
        ))

    def _apply_periodic_costs(self, i: int) -> None:
        # Funding for perp-style positions
        if self.funding_period_bars > 0 and (self.bar_counter + 1) % self.funding_period_bars == 0:
            for sym, pos in self.book.positions.items():
                if pos.qty == 0:
                    continue
                px = float(self.market.arrays[sym].close[i])
                notional = abs(pos.qty) * px
                charge = funding_charge(notional, self.costs)
                amount = charge if pos.qty > 0 else -charge
                pos.funding_accum += amount
                self.account.apply_funding(amount)
        # Borrow on shorts every bar
        for sym, pos in self.book.positions.items():
            if pos.qty >= 0:
                continue
            px = float(self.market.arrays[sym].close[i])
            notional = abs(pos.qty) * px
            charge = borrow_charge_per_bar(notional, self.costs, self.bars_per_year)
            if charge > 0:
                pos.borrow_accum += charge
                self.account.apply_funding(charge)
