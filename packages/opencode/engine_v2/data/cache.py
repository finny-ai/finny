"""Parquet (or CSV fallback) cache for OHLCV under ~/.finny/cache/.

Layout: <root>/<provider>/<symbol-safe>/<interval>/<year>.parquet

Concurrency: writes go through tempfile + os.replace (atomic). A per-key
fcntl.flock prevents two processes from racing on the same file. Reads
tolerate missing/partial cache (fall through to provider).

Year-based partition: a 5-year intraday-minute series stays under a few
hundred MB per file, and partial-range fetches only need 1-2 partitions.
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import pandas as pd

try:
    import pyarrow  # noqa: F401
    _HAVE_PARQUET = True
except ImportError:
    _HAVE_PARQUET = False


def default_cache_root() -> Path:
    return Path(os.path.expanduser("~/.finny/cache"))


def _safe_symbol(symbol: str) -> str:
    return symbol.replace("/", "_").replace(":", "_")


def _partition_path(root: Path, provider: str, symbol: str, interval: str, year: int) -> Path:
    ext = ".parquet" if _HAVE_PARQUET else ".csv"
    return root / provider / _safe_symbol(symbol) / interval / f"{year}{ext}"


@contextlib.contextmanager
def _flock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _atomic_write(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        if _HAVE_PARQUET:
            df.to_parquet(tmp_path, index=False)
        else:
            df.to_csv(tmp_path, index=False)
        os.replace(tmp_path, path)
    except Exception:
        with contextlib.suppress(FileNotFoundError):
            tmp_path.unlink()
        raise


def _read_partition(path: Path) -> Optional[pd.DataFrame]:
    if not path.exists():
        return None
    try:
        if _HAVE_PARQUET and path.suffix == ".parquet":
            return pd.read_parquet(path)
        return pd.read_csv(path, parse_dates=["timestamp"])
    except Exception as e:
        print(f"__FINNY_CACHE_WARN__: read_failed: {path}: {e}", file=sys.stderr)
        return None


@dataclass
class CacheConfig:
    root: Path = None  # type: ignore[assignment]
    provider: str = "yfinance"

    def __post_init__(self) -> None:
        if self.root is None:
            self.root = default_cache_root()


def load_range(
    cfg: CacheConfig,
    symbol: str,
    interval: str,
    start: pd.Timestamp,
    end: pd.Timestamp,
    fetch_fn: Callable[[str, str], pd.DataFrame],
) -> pd.DataFrame:
    """Cache-first range load. `start` and `end` must be UTC-aware (naive
    timestamps will be assumed UTC). `fetch_fn(start, end)` is the cold-path
    provider call (only invoked for missing year partitions). Stitches results
    and filters to [start, end)."""
    start = start.tz_localize("UTC") if start.tzinfo is None else start.tz_convert("UTC")
    end = end.tz_localize("UTC") if end.tzinfo is None else end.tz_convert("UTC")
    years = list(range(int(start.year), int(end.year) + 1))
    frames = []
    for y in years:
        path = _partition_path(cfg.root, cfg.provider, symbol, interval, y)
        df = _read_partition(path)
        if df is None or df.empty:
            with _flock(path):
                df = _read_partition(path)
                if df is None or df.empty:
                    y_start = pd.Timestamp(f"{y}-01-01", tz="UTC")
                    y_end = pd.Timestamp(f"{y + 1}-01-01", tz="UTC")
                    s = max(y_start, start - pd.Timedelta(days=1))
                    e = min(y_end, end + pd.Timedelta(days=1))
                    try:
                        df = fetch_fn(s.strftime("%Y-%m-%d"), e.strftime("%Y-%m-%d"))
                    except Exception as fetch_err:
                        print(
                            f"__FINNY_CACHE_WARN__: fetch_failed: {symbol} {interval} {y}: {fetch_err}",
                            file=sys.stderr,
                        )
                        df = pd.DataFrame()
                    if not df.empty:
                        _atomic_write(path, df)
        if df is not None and not df.empty:
            frames.append(df)
    if not frames:
        return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])
    out = pd.concat(frames, ignore_index=True)
    out["timestamp"] = pd.to_datetime(out["timestamp"], utc=True)
    out = out.drop_duplicates(subset=["timestamp"]).sort_values("timestamp")
    out = out[(out["timestamp"] >= start) & (out["timestamp"] < end)].reset_index(drop=True)
    return out
