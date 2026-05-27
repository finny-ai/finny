"""Asset specifications used by data, execution, margin, and reporting."""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass
from typing import Any, Dict, Optional


AssetClass = str
_OPTION_RE = re.compile(r"^[A-Z]{1,6}/\d{8}/\d+(?:\.\d+)?[CP]$", re.IGNORECASE)
CRYPTO_BASES = {"BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "DOT", "AVAX", "LINK", "UNI"}


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
    if len(sym) == 6 and sym.isalpha() and sym[:3] not in CRYPTO_BASES:
        return "fx"
    if len(sym) == 7 and sym[3] in {"/", "-"} and sym[:3].isalpha() and sym[4:].isalpha() and sym[:3] not in CRYPTO_BASES:
        return "fx"
    if "/" in sym or "-" in sym or sym.endswith("USDT") or sym.endswith("USD"):
        return "crypto_spot"
    return "equity"


def resolve_asset_spec(cfg: Dict[str, Any]) -> AssetSpec:
    symbol = str(cfg.get("symbol", "")).upper()
    asset_class = normalize_asset_class(cfg.get("asset_class") or cfg.get("assetClass"), symbol)
    spec_cfg = dict(cfg.get("asset_spec") or cfg.get("assetSpec") or {})
    exec_cfg = cfg.get("execution", {}) or {}
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
        return {**common, "assetClass": asset_class, "venue": "CME", "calendar": "US_FUTURES",
                "tickSize": 0.25, "lotSize": 1.0, "multiplier": 50.0,
                "productionEligible": True, "rollPolicy": "continuous_contract_assumed"}
    if asset_class == "fx":
        quote = symbol[3:6] if len(symbol) >= 6 else "USD"
        return {**common, "assetClass": asset_class, "venue": "fx_spot", "calendar": "FX_24_5",
                "currency": quote, "tickSize": 0.01 if quote == "JPY" else 0.0001,
                "lotSize": 1000.0, "multiplier": 1.0, "productionEligible": True,
                "baseCurrency": symbol[:3] if len(symbol) >= 3 else None, "quoteCurrency": quote}
    if asset_class == "option":
        return {**common, "assetClass": asset_class, "venue": "OPRA", "calendar": "US_OPTIONS",
                "tickSize": 0.01, "lotSize": 1.0, "multiplier": 100.0,
                "dataProvider": "synthetic_options",
                "productionEligible": True}
    return {**common, "assetClass": "equity", "venue": "equity", "calendar": "US_EQUITIES",
            "tickSize": 0.01, "lotSize": 1.0, "multiplier": 1.0, "productionEligible": True}
