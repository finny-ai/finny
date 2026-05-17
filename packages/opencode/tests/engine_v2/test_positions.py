"""Position math: open, add, reduce, close, flip, MAE/MFE, R-multiples."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine_v2.portfolio.positions import PositionBook


def _book():
    return PositionBook()


def test_open_long_then_close_realizes_pnl():
    b = _book()
    b.apply_fill("X", "buy", qty=10, price=100.0, fee=0.0, ts_ns=0, tag="entry")
    pos = b.get("X")
    assert pos.qty == 10 and pos.avg_price == 100.0
    realized = b.apply_fill("X", "sell", qty=10, price=110.0, fee=0.0, ts_ns=1, tag="exit")
    assert abs(realized - 100.0) < 1e-9
    assert b.get("X").qty == 0
    assert len(b.trades) == 1
    t = b.trades[0]
    assert abs(t.pnl - 100.0) < 1e-9
    assert t.side == "long"


def test_add_long_recomputes_avg():
    b = _book()
    b.apply_fill("X", "buy", qty=10, price=100.0, fee=0.0, ts_ns=0, tag="a")
    b.apply_fill("X", "buy", qty=10, price=120.0, fee=0.0, ts_ns=1, tag="b")
    pos = b.get("X")
    assert pos.qty == 20
    assert abs(pos.avg_price - 110.0) < 1e-9


def test_partial_reduce_keeps_avg_realizes_proportional():
    b = _book()
    b.apply_fill("X", "buy", qty=10, price=100.0, fee=0.0, ts_ns=0, tag="a")
    realized = b.apply_fill("X", "sell", qty=4, price=120.0, fee=0.0, ts_ns=1, tag="r")
    assert abs(realized - 80.0) < 1e-9
    pos = b.get("X")
    assert pos.qty == 6 and abs(pos.avg_price - 100.0) < 1e-9
    assert len(b.trades) == 0  # not yet flat
    b.apply_fill("X", "sell", qty=6, price=130.0, fee=0.0, ts_ns=2, tag="r2")
    assert len(b.trades) == 1
    assert b.trades[0].qty == 10  # original full qty captured at trade emit


def test_short_open_close():
    b = _book()
    b.apply_fill("X", "sell", qty=5, price=100.0, fee=0.0, ts_ns=0, tag="sh")
    pos = b.get("X")
    assert pos.qty == -5 and pos.avg_price == 100.0
    realized = b.apply_fill("X", "buy", qty=5, price=80.0, fee=0.0, ts_ns=1, tag="cv")
    assert abs(realized - 100.0) < 1e-9
    assert b.trades[0].side == "short" and b.trades[0].pnl > 0


def test_flip_long_to_short_emits_long_trade_opens_short():
    b = _book()
    b.apply_fill("X", "buy", qty=10, price=100.0, fee=0.0, ts_ns=0, tag="long")
    realized = b.apply_fill("X", "sell", qty=15, price=110.0, fee=0.0, ts_ns=1, tag="flip")
    assert abs(realized - 100.0) < 1e-9   # long PnL realized
    assert len(b.trades) == 1
    assert b.trades[0].side == "long"
    pos = b.get("X")
    assert pos.qty == -5 and pos.avg_price == 110.0


def test_fees_attributed_to_trade():
    b = _book()
    b.apply_fill("X", "buy", qty=10, price=100.0, fee=2.0, ts_ns=0, tag="a")
    b.apply_fill("X", "sell", qty=10, price=110.0, fee=2.2, ts_ns=1, tag="b")
    t = b.trades[0]
    assert abs(t.pnl - (100.0 - 4.2)) < 1e-9
    assert abs(t.fees - 4.2) < 1e-9


def test_mae_mfe_long():
    b = _book()
    b.apply_fill("X", "buy", qty=10, price=100.0, fee=0.0, ts_ns=0, tag="a")
    pos = b.get("X")
    # Simulate bar marks
    pos.mark(105.0)   # mfe candidate
    pos.mark(95.0)    # mae candidate
    pos.mark(108.0)
    b.apply_fill("X", "sell", qty=10, price=108.0, fee=0.0, ts_ns=1, tag="exit")
    t = b.trades[0]
    assert abs(t.mfe - 80.0) < 1e-9   # (108-100)*10? no, peak=108 -> (108-100)*10=80
    assert abs(t.mae - 50.0) < 1e-9   # (100-95)*10=50
