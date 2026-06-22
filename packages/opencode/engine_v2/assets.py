"""Asset specifications used by data, execution, margin, and reporting."""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional


AssetClass = str
_OPTION_RE = re.compile(r"^[A-Z]{1,6}/\d{8}/\d+(?:\.\d+)?[CP]$", re.IGNORECASE)
CRYPTO_BASES = {"BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "DOT", "AVAX", "LINK", "UNI"}

# Roots accepted as futures in backtest. yfinance serves these as e.g. "ES=F";
# IBKR live uses "ES/202612" or "ES/CONT". Canonical in config is the bare root.
FUTURES_SPECS: Dict[str, Dict[str, Any]] = {
    "ES": {"venue": "CME", "tickSize": 0.25, "multiplier": 50.0, "currency": "USD", "initialMarginPct": 0.05, "maintenanceMarginPct": 0.04, "commissionPerContract": 2.25},
    "NQ": {"venue": "CME", "tickSize": 0.25, "multiplier": 20.0, "currency": "USD", "initialMarginPct": 0.06, "maintenanceMarginPct": 0.05, "commissionPerContract": 2.25},
    "RTY": {"venue": "CME", "tickSize": 0.10, "multiplier": 50.0, "currency": "USD", "initialMarginPct": 0.07, "maintenanceMarginPct": 0.06, "commissionPerContract": 2.25},
    "YM": {"venue": "CBOT", "tickSize": 1.0, "multiplier": 5.0, "currency": "USD", "initialMarginPct": 0.05, "maintenanceMarginPct": 0.04, "commissionPerContract": 2.25},
    "CL": {"venue": "NYMEX", "tickSize": 0.01, "multiplier": 1000.0, "currency": "USD", "initialMarginPct": 0.10, "maintenanceMarginPct": 0.08, "commissionPerContract": 2.75},
    "GC": {"venue": "COMEX", "tickSize": 0.10, "multiplier": 100.0, "currency": "USD", "initialMarginPct": 0.08, "maintenanceMarginPct": 0.06, "commissionPerContract": 2.60},
    "SI": {"venue": "COMEX", "tickSize": 0.005, "multiplier": 5000.0, "currency": "USD", "initialMarginPct": 0.12, "maintenanceMarginPct": 0.10, "commissionPerContract": 2.90},
    "HG": {"venue": "COMEX", "tickSize": 0.0005, "multiplier": 25000.0, "currency": "USD", "initialMarginPct": 0.09, "maintenanceMarginPct": 0.07, "commissionPerContract": 2.75},
    "ZN": {"venue": "CBOT", "tickSize": 0.015625, "multiplier": 1000.0, "currency": "USD", "initialMarginPct": 0.03, "maintenanceMarginPct": 0.025, "commissionPerContract": 2.10},
    "ZB": {"venue": "CBOT", "tickSize": 0.03125, "multiplier": 1000.0, "currency": "USD", "initialMarginPct": 0.04, "maintenanceMarginPct": 0.03, "commissionPerContract": 2.10},
    "6E": {"venue": "CME", "tickSize": 0.00005, "multiplier": 125000.0, "currency": "USD", "initialMarginPct": 0.04, "maintenanceMarginPct": 0.03, "commissionPerContract": 2.40},
}
FUTURES_ROOTS = set(FUTURES_SPECS)


def _strip_futures_suffix(symbol: str) -> str:
    s = str(symbol).strip().upper()
    if s.endswith("=F"):
        return s[:-2]
    if s.endswith("/CONT"):
        return s[:-5]
    return s


def is_futures_root(symbol: str) -> bool:
    return _strip_futures_suffix(symbol) in FUTURES_ROOTS


def futures_root(symbol: str) -> Optional[str]:
    root = _strip_futures_suffix(symbol)
    return root if root in FUTURES_ROOTS else None


def to_yfinance_symbol(symbol: str, asset_class: Optional[AssetClass] = None) -> str:
    """Map a canonical symbol to the form yfinance expects.

    - Futures: bare root (or `/CONT` form) → root + `=F`; existing `=F` preserved.
    - Crypto pairs: `BTC/USD` → `BTC-USD` (yfinance uses dashes, not slashes).
    - Everything else passes through uppercased.
    """
    s = str(symbol).strip().upper()
    root = _strip_futures_suffix(s)
    if (asset_class == "future") or (asset_class is None and root in FUTURES_ROOTS):
        if root in FUTURES_ROOTS:
            return root + "=F"
        return s if s.endswith("=F") else s
    return s.replace("/", "-")


@dataclass(frozen=True)
class AssetSpec:
    assetClass: AssetClass
    symbol: str
    currency: str
    calendar: str
    tickSize: float
    lotSize: float
    multiplier: float
    feeModel: str
    marginModel: str
    dataProvider: str
    productionEligible: bool
    initialMarginPct: Optional[float] = None
    maintenanceMarginPct: Optional[float] = None
    commissionPerContract: Optional[float] = None
    venue: Optional[str] = None
    expiry: Optional[str] = None
    rollPolicy: Optional[str] = None
    quoteCurrency: Optional[str] = None
    baseCurrency: Optional[str] = None
    blockingReason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def notional(self, qty: float, price: float) -> float:
        return abs(float(qty) * float(price) * self.multiplier)

    def signed_pnl(self, qty: float, entry: float, exit_price: float) -> float:
        return float(qty) * (float(exit_price) - float(entry)) * self.multiplier

    def round_qty(self, qty: float) -> float:
        lot = self.lotSize
        if lot <= 0:
            return float(qty)
        steps = math.floor((float(qty) / lot) + 1e-12)
        return steps * lot

    def round_price(self, price: float) -> float:
        tick = self.tickSize
        if tick <= 0:
            return float(price)
        return round(round(float(price) / tick) * tick, 12)

    @property
    def volume_required(self) -> bool:
        return self.assetClass in {"crypto_spot", "crypto_perp", "equity", "future", "option"}


def normalize_asset_class(value: Any, symbol: str) -> AssetClass:
    raw = str(value or "").strip().lower()
    if raw == "crypto":
        return "crypto_spot"
    if raw in {"crypto_spot", "crypto_perp", "equity", "future", "fx", "option"}:
        return raw
    sym = str(symbol).upper()
    if _OPTION_RE.match(sym):
        return "option"
    if is_futures_root(sym):
        return "future"
    if len(sym) == 6 and sym.isalpha() and sym[:3] not in CRYPTO_BASES:
        return "fx"
    if len(sym) == 7 and sym[3] in {"/", "-"} and sym[:3].isalpha() and sym[4:].isalpha() and sym[:3] not in CRYPTO_BASES:
        return "fx"
    if "/" in sym or "-" in sym or sym.endswith("USDT") or sym.endswith("USD"):
        return "crypto_spot"
    # A bare ticker that exactly matches a curated major crypto base (e.g.
    # "BTC", "ETH", "SOL") is crypto spot. Restricted to the explicit
    # CRYPTO_BASES set so ordinary equity tickers are never misrouted.
    if sym in CRYPTO_BASES:
        return "crypto_spot"
    return "equity"


def resolve_asset_spec(cfg: Dict[str, Any]) -> AssetSpec:
    symbol = str(cfg.get("symbol", "")).upper()
    asset_class = normalize_asset_class(cfg.get("asset_class") or cfg.get("assetClass"), symbol)
    spec_cfg = dict(cfg.get("asset_spec") or cfg.get("assetSpec") or {})
    exec_cfg = cfg.get("execution", {}) or {}

    # Guard unknown futures roots: silently simulating an unsupported/typo'd
    # contract with ES specs would produce wrong margin/tick/multiplier (and
    # thus wrong sizing, fees, and liquidation) with no warning. Require an
    # explicit asset_spec override (multiplier + tickSize at minimum) instead.
    if asset_class == "future" and futures_root(symbol) is None:
        if not (spec_cfg.get("multiplier") and spec_cfg.get("tickSize")):
            raise ValueError(
                f"Unsupported futures root for symbol {symbol!r}. "
                f"Supported roots: {', '.join(sorted(FUTURES_ROOTS))}. "
                f"To backtest another contract, pass an explicit asset_spec with at "
                f"least multiplier and tickSize."
            )

    base = _defaults(asset_class, symbol, exec_cfg)
    base.update(spec_cfg)
    base["assetClass"] = asset_class
    base["symbol"] = symbol
    spec = AssetSpec(**{k: v for k, v in base.items() if k in AssetSpec.__dataclass_fields__})
    if spec.tickSize <= 0 or spec.lotSize <= 0 or spec.multiplier <= 0:
        raise ValueError("AssetSpec tickSize, lotSize, and multiplier must be positive")
    return spec


def _defaults(asset_class: AssetClass, symbol: str, exec_cfg: Dict[str, Any]) -> Dict[str, Any]:
    common = {
        "symbol": symbol,
        "currency": "USD",
        "feeModel": "engine_v2.execution.costs",
        "marginModel": "engine_v2.portfolio.account",
        "dataProvider": "yfinance",
    }
    if asset_class == "crypto_spot":
        return {**common, "assetClass": asset_class, "venue": "crypto", "calendar": "24/7",
                "tickSize": 0.01, "lotSize": 0.00000001, "multiplier": 1.0, "productionEligible": True}
    if asset_class == "crypto_perp":
        funding = float(exec_cfg.get("funding_rate_bps", 0.0) or 0.0)
        maint = float(exec_cfg.get("maintenance_margin_pct", 0.0) or 0.0)
        return {**common, "assetClass": asset_class, "venue": "crypto_perp", "calendar": "24/7",
                "tickSize": 0.01, "lotSize": 0.001, "multiplier": 1.0,
                "productionEligible": funding != 0.0 and maint > 0.0,
                "blockingReason": None if funding != 0.0 and maint > 0.0 else "Perp production eligibility requires funding and maintenance margin."}
    if asset_class == "future":
        futures = FUTURES_SPECS.get(futures_root(symbol) or "", FUTURES_SPECS["ES"])
        return {**common, **futures, "assetClass": asset_class, "calendar": "US_FUTURES",
                "lotSize": 1.0,
                "productionEligible": True, "rollPolicy": "continuous_contract_assumed"}
    if asset_class == "fx":
        quote = symbol[3:6] if len(symbol) >= 6 else "USD"
        return {**common, "assetClass": asset_class, "venue": "fx_spot", "calendar": "FX_24_5",
                "currency": quote, "tickSize": 0.01 if quote == "JPY" else 0.0001,
                "lotSize": 1000.0, "multiplier": 1.0, "productionEligible": True,
                "baseCurrency": symbol[:3] if len(symbol) >= 3 else None, "quoteCurrency": quote}
    if asset_class == "option":
        # Keep options NOT production-eligible to match the TS validator, which
        # hard-blocks assetClass === "option" unless FINNY_ALLOW_EXPERIMENTAL_OPTIONS=1.
        # Marking them eligible here created a cross-language mismatch (engine
        # said "eligible" while the toolchain rejected the strategy).
        return {**common, "assetClass": asset_class, "venue": "OPRA", "calendar": "US_OPTIONS",
                "tickSize": 0.01, "lotSize": 1.0, "multiplier": 100.0,
                "dataProvider": "synthetic_options",
                "productionEligible": False,
                "blockingReason": "Options remain experimental and are not production-eligible in engine_v2."}
    return {**common, "assetClass": "equity", "venue": "equity", "calendar": "US_EQUITIES",
            "tickSize": 0.01, "lotSize": 1.0, "multiplier": 1.0, "productionEligible": True}
