"""Data extractor — multi-source fetch, quality check, parquet write, digest.

Called by the TS tool via extract_cli.py. Writes parquet into the algo's
data/{stock,crypto}/ directory and returns a JSON digest the LLM can
consume without drowning in raw numbers.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .cache import CacheConfig, load_range
from .providers.binance import BinanceProvider
from .providers.yfinance import YFinanceProvider
from .quality import QualityReport, analyze

_CRYPTO_BASES = {
    "BTC", "ETH", "SOL", "DOGE", "XRP", "ADA", "AVAX", "DOT", "LINK",
    "MATIC", "SHIB", "UNI", "ATOM", "LTC", "BCH", "NEAR", "FIL", "APT",
    "ARB", "OP", "SUI", "PEPE", "WIF", "BONK", "FLOKI", "INJ", "TIA",
    "SEI", "JUP", "RENDER", "FET", "TAO", "ONDO", "PENDLE",
}


def _classify_asset(symbol: str) -> str:
    base = symbol.split("/")[0].split("-")[0].upper()
    if base in _CRYPTO_BASES:
        return "crypto"
    return "stock"


@dataclass
class SourceResult:
    provider: str
    bars: int
    quality: Optional[QualityReport]
    error: Optional[str] = None


@dataclass
class ExtractResult:
    symbol: str
    canonical: str
    asset_class: str
    interval: str
    start: str
    end: str
    parquet_path: str
    bars_written: int
    sources_tried: List[SourceResult] = field(default_factory=list)
    digest: Dict = field(default_factory=dict)


def _build_digest(df: pd.DataFrame, symbol: str, interval: str) -> Dict:
    """Structured summary for LLM consumption — stats, not raw rows."""
    if df.empty:
        return {"symbol": symbol, "bars": 0, "status": "no_data"}

    c = df["close"].to_numpy()
    v = df["volume"].to_numpy()
    total_return = float((c[-1] / c[0]) - 1) if c[0] != 0 else 0.0

    log_ret = np.diff(np.log(np.clip(c, 1e-12, None)))
    ann_factor = {"1m": 525600, "5m": 105120, "15m": 35040, "30m": 17520,
                  "1h": 8760, "4h": 2190, "1d": 365}.get(interval, 365)
    ann_vol = float(np.std(log_ret, ddof=1) * np.sqrt(ann_factor)) if len(log_ret) > 1 else 0.0

    peak = np.maximum.accumulate(c)
    dd = (c - peak) / np.where(peak > 0, peak, 1)
    max_dd = float(dd.min())

    avg_vol = float(np.mean(v))

    ts = pd.to_datetime(df["timestamp"])
    first_ts = ts.iloc[0].isoformat()
    last_ts = ts.iloc[-1].isoformat()

    pct_50 = np.percentile(c, 50)
    pct_5 = np.percentile(c, 5)
    pct_95 = np.percentile(c, 95)

    return {
        "symbol": symbol,
        "interval": interval,
        "bars": len(df),
        "period": {"start": first_ts, "end": last_ts},
        "price": {
            "open": round(float(c[0]), 6),
            "close": round(float(c[-1]), 6),
            "high": round(float(df["high"].max()), 6),
            "low": round(float(df["low"].min()), 6),
            "p5": round(float(pct_5), 6),
            "median": round(float(pct_50), 6),
            "p95": round(float(pct_95), 6),
        },
        "performance": {
            "total_return_pct": round(total_return * 100, 4),
            "annualized_volatility_pct": round(ann_vol * 100, 4),
            "max_drawdown_pct": round(max_dd * 100, 4),
        },
        "volume": {
            "avg_daily": round(avg_vol, 2),
            "total": round(float(np.sum(v)), 2),
        },
    }


def _try_fetch(
    provider, symbol: str, start: str, end: str, interval: str
) -> tuple[Optional[pd.DataFrame], Optional[str]]:
    try:
        if not provider.supports_interval(interval):
            return None, f"{provider.name} does not support interval {interval}"
        df = provider.fetch(symbol, start, end, interval)
        if df is None or df.empty:
            return None, "empty result"
        return df, None
    except Exception as e:
        return None, str(e)


def extract(
    symbol: str,
    interval: str,
    start: str,
    end: str,
    algo_dir: str,
) -> ExtractResult:
    """Fetch from best source, write parquet, return digest."""
    asset_class = _classify_asset(symbol)
    subdir = "crypto" if asset_class == "crypto" else "stock"
    data_dir = Path(algo_dir) / "data" / subdir
    data_dir.mkdir(parents=True, exist_ok=True)

    safe_sym = symbol.replace("/", "-").replace(" ", "_")
    parquet_name = f"{safe_sym}_{interval}_{start}_{end}.parquet"
    parquet_path = data_dir / parquet_name

    sources_tried: List[SourceResult] = []
    best_df: Optional[pd.DataFrame] = None
    best_quality: Optional[QualityReport] = None
    best_provider: Optional[str] = None

    if asset_class == "crypto":
        providers = [BinanceProvider(), YFinanceProvider()]
    else:
        providers = [YFinanceProvider()]

    for prov in providers:
        df, err = _try_fetch(prov, symbol, start, end, interval)
        if err:
            sources_tried.append(SourceResult(provider=prov.name, bars=0, quality=None, error=err))
            continue

        qr = analyze(df, interval, asset_class)
        sources_tried.append(SourceResult(provider=prov.name, bars=qr.n_bars, quality=qr))

        if best_df is None or qr.n_bars > (best_quality.n_bars if best_quality else 0):
            best_df = df
            best_quality = qr
            best_provider = prov.name

    if best_df is None or best_df.empty:
        return ExtractResult(
            symbol=symbol,
            canonical=symbol,
            asset_class=asset_class,
            interval=interval,
            start=start,
            end=end,
            parquet_path="",
            bars_written=0,
            sources_tried=sources_tried,
            digest={"symbol": symbol, "bars": 0, "status": "no_data"},
        )

    best_df = best_df.sort_values("timestamp").drop_duplicates(subset=["timestamp"]).reset_index(drop=True)

    try:
        import pyarrow  # noqa: F401
        best_df.to_parquet(parquet_path, index=False)
    except ImportError:
        csv_path = parquet_path.with_suffix(".csv")
        best_df.to_csv(csv_path, index=False)
        parquet_path = csv_path

    digest = _build_digest(best_df, symbol, interval)
    digest["source"] = best_provider
    digest["quality"] = {
        "coverage_pct": round(best_quality.coverage_pct * 100, 2) if best_quality else 0,
        "gaps": best_quality.gap_count if best_quality else 0,
        "ohlc_violations": best_quality.ohlc_violations if best_quality else 0,
        "outlier_bars": best_quality.outlier_bars if best_quality else 0,
        "notes": best_quality.notes if best_quality else [],
    }

    return ExtractResult(
        symbol=symbol,
        canonical=symbol,
        asset_class=asset_class,
        interval=interval,
        start=start,
        end=end,
        parquet_path=str(parquet_path),
        bars_written=len(best_df),
        sources_tried=sources_tried,
        digest=digest,
    )


def result_to_json(result: ExtractResult) -> str:
    """Serialize for TS tool consumption."""
    d = {
        "symbol": result.symbol,
        "asset_class": result.asset_class,
        "interval": result.interval,
        "period": {"start": result.start, "end": result.end},
        "parquet_path": result.parquet_path,
        "bars_written": result.bars_written,
        "sources": [
            {
                "provider": s.provider,
                "bars": s.bars,
                "error": s.error,
                "quality": asdict(s.quality) if s.quality else None,
            }
            for s in result.sources_tried
        ],
        "digest": result.digest,
    }
    return json.dumps(d, indent=2, default=str)
