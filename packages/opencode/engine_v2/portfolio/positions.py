"""Position bookkeeping. Long+short via signed qty; avg-cost on opens/adds,
realized PnL on reduces. Closed trades emitted as TradeRow records.

Trade lifecycle:
  - open / add → record entry snapshot.
  - reduce / flip / close → realize PnL on the closed portion, record a trade,
    capture MAE/MFE across the trade's lifetime.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


def _sign(x: float) -> int:
    return 1 if x > 0 else (-1 if x < 0 else 0)


@dataclass
class ClosedTrade:
    symbol: str
    side: str  # "long" | "short"
    entry_ts_ns: int
    exit_ts_ns: int
    qty: float
    entry_price: float
    exit_price: float
    pnl: float
    fees: float
    funding: float
    borrow: float
    mae: float          # worst price excursion vs entry (always positive $ loss)
    mfe: float          # best price excursion vs entry (always positive $ gain)
    hold_bars: int
    entry_tag: str
    exit_tag: str
    stop_distance: Optional[float]  # for R-multiples; None if entry had no stop
    liquidation: bool = False
    multiplier: float = 1.0


@dataclass
class Position:
    symbol: str
    qty: float = 0.0          # +long, -short
    avg_price: float = 0.0
    # Lifetime accumulators for the *currently open* trade. Reset on flat.
    entry_ts_ns: int = 0
    entry_price: float = 0.0
    entry_tag: str = ""
    fees_accum: float = 0.0
    funding_accum: float = 0.0
    borrow_accum: float = 0.0
    high_water: float = 0.0   # best price vs entry direction
    low_water: float = 0.0    # worst price vs entry direction
    bars_held: int = 0
    stop_distance: Optional[float] = None
    realized_accum: float = 0.0   # PnL realized on partial reduces within this open trade
    peak_abs_qty: float = 0.0     # max |qty| held since flat (for trade.qty on emit)
    side_at_open: str = ""        # "long" | "short" — captured at flat→non-flat
    multiplier: float = 1.0

    def is_flat(self) -> bool:
        return self.qty == 0.0

    def is_long(self) -> bool:
        return self.qty > 0.0

    def is_short(self) -> bool:
        return self.qty < 0.0

    def mark(self, last_price: float) -> None:
        """Tick excursion tracking once per bar while position is open."""
        if self.qty == 0:
            return
        self.bars_held += 1
        if self.high_water == 0.0 and self.low_water == 0.0:
            self.high_water = last_price
            self.low_water = last_price
        else:
            if last_price > self.high_water:
                self.high_water = last_price
            if last_price < self.low_water:
                self.low_water = last_price

    def unrealized_pnl(self, last_price: float) -> float:
        if self.qty == 0:
            return 0.0
        return self.qty * (last_price - self.avg_price) * self.multiplier


@dataclass
class PositionBook:
    positions: dict = field(default_factory=dict)
    trades: List[ClosedTrade] = field(default_factory=list)

    def get(self, symbol: str) -> Position:
        if symbol not in self.positions:
            self.positions[symbol] = Position(symbol=symbol)
        return self.positions[symbol]

    def apply_fill(
        self,
        symbol: str,
        side: str,
        qty: float,
        price: float,
        fee: float,
        ts_ns: int,
        tag: str,
        stop_distance: Optional[float] = None,
        liquidation: bool = False,
        multiplier: float = 1.0,
    ) -> float:
        """Apply a fill. Returns realized cash delta (excluding fee).

        Buy adds to qty; sell subtracts. Cash flow handled by Account separately
        using the returned realized delta and the fee.
        """
        pos = self.get(symbol)
        signed_qty = qty if side == "buy" else -qty
        old_qty = pos.qty
        new_qty = old_qty + signed_qty
        realized = 0.0

        # Flat → open
        if old_qty == 0.0:
            pos.qty = new_qty
            pos.avg_price = price
            pos.entry_ts_ns = ts_ns
            pos.entry_price = price
            pos.entry_tag = tag
            pos.fees_accum = fee
            pos.high_water = price
            pos.low_water = price
            pos.bars_held = 0
            pos.stop_distance = stop_distance
            pos.realized_accum = 0.0
            pos.peak_abs_qty = abs(new_qty)
            pos.side_at_open = "long" if new_qty > 0 else "short"
            pos.multiplier = float(multiplier)
            return 0.0

        same_sign = _sign(new_qty) == _sign(old_qty) and new_qty != 0.0
        sign_flipped = _sign(new_qty) != _sign(old_qty) and new_qty != 0.0
        # Adding to existing position
        if same_sign and abs(new_qty) > abs(old_qty):
            pos.avg_price = (pos.avg_price * old_qty + price * signed_qty) / new_qty
            pos.qty = new_qty
            pos.fees_accum += fee
            pos.peak_abs_qty = max(pos.peak_abs_qty, abs(new_qty))
            return 0.0

        # Reducing (partial or full close, same sign)
        if same_sign and abs(new_qty) < abs(old_qty):
            closed_qty = abs(signed_qty)
            realized = closed_qty * (price - pos.avg_price) * _sign(old_qty) * pos.multiplier
            pos.qty = new_qty
            pos.fees_accum += fee
            pos.realized_accum += realized
            return realized

        # Full close (new_qty == 0)
        if new_qty == 0.0:
            closed_qty = abs(old_qty)
            realized = closed_qty * (price - pos.avg_price) * _sign(old_qty) * pos.multiplier
            pos.realized_accum += realized
            self._emit_trade(pos, exit_ts_ns=ts_ns, exit_price=price,
                             exit_fee=fee, exit_tag=tag,
                             liquidation=liquidation)
            self.positions[symbol] = Position(symbol=symbol)
            return realized

        # Flip: close old fully then open new on the other side at this price
        if sign_flipped:
            closed_qty = abs(old_qty)
            realized = closed_qty * (price - pos.avg_price) * _sign(old_qty) * pos.multiplier
            close_fee = fee * (closed_qty / abs(signed_qty))
            open_fee = fee - close_fee
            pos.realized_accum += realized
            self._emit_trade(pos, exit_ts_ns=ts_ns, exit_price=price,
                             exit_fee=close_fee, exit_tag=tag,
                             liquidation=liquidation)
            self.positions[symbol] = Position(
                symbol=symbol, qty=new_qty, avg_price=price,
                entry_ts_ns=ts_ns, entry_price=price, entry_tag=tag,
                fees_accum=open_fee, high_water=price, low_water=price,
                bars_held=0, stop_distance=stop_distance,
                peak_abs_qty=abs(new_qty),
                side_at_open="long" if new_qty > 0 else "short",
                multiplier=float(multiplier),
            )
            return realized

        return realized

    def _emit_trade(
        self,
        pos: Position,
        exit_ts_ns: int,
        exit_price: float,
        exit_fee: float,
        exit_tag: str,
        liquidation: bool,
    ) -> None:
        side = pos.side_at_open or ("long" if pos.qty > 0 else "short")
        peak = pos.peak_abs_qty or 1.0
        if side == "long":
            mfe = max(0.0, (pos.high_water - pos.entry_price) * peak * pos.multiplier)
            mae = max(0.0, (pos.entry_price - pos.low_water) * peak * pos.multiplier)
        else:
            mfe = max(0.0, (pos.entry_price - pos.low_water) * peak * pos.multiplier)
            mae = max(0.0, (pos.high_water - pos.entry_price) * peak * pos.multiplier)
        total_fees = pos.fees_accum + exit_fee
        self.trades.append(ClosedTrade(
            symbol=pos.symbol,
            side=side,
            entry_ts_ns=pos.entry_ts_ns,
            exit_ts_ns=exit_ts_ns,
            qty=pos.peak_abs_qty,
            entry_price=pos.entry_price,
            exit_price=exit_price,
            pnl=pos.realized_accum - total_fees - pos.funding_accum - pos.borrow_accum,
            fees=total_fees,
            funding=pos.funding_accum,
            borrow=pos.borrow_accum,
            mae=mae,
            mfe=mfe,
            hold_bars=pos.bars_held,
            entry_tag=pos.entry_tag,
            exit_tag=exit_tag,
            stop_distance=pos.stop_distance,
            liquidation=liquidation,
            multiplier=pos.multiplier,
        ))

    def mark_all(self, prices: dict) -> None:
        for sym, pos in self.positions.items():
            px = prices.get(sym)
            if px is not None:
                pos.mark(float(px))

    def gross_exposure(self, prices: dict) -> float:
        return sum(abs(p.qty) * float(prices.get(s, 0.0)) * p.multiplier for s, p in self.positions.items())

    def net_exposure(self, prices: dict) -> float:
        return sum(p.qty * float(prices.get(s, 0.0)) * p.multiplier for s, p in self.positions.items())
