"""Benchmark series resolver. Picks SPY for equities, BTC-USD for crypto.
Caller fetches via provider; this only maps asset class → benchmark symbol."""

from __future__ import annotations

CRYPTO_BENCHMARK = "BTC/USD"
EQUITY_BENCHMARK = "SPY"


def benchmark_for(asset_class: str) -> str:
    return CRYPTO_BENCHMARK if asset_class == "crypto" else EQUITY_BENCHMARK


def classify(symbol: str) -> str:
    upper = symbol.upper()
    if "/" in upper or "-" in upper or upper.endswith(("USD", "USDT", "USDC")):
        return "crypto"
    crypto_bases = {
        "BTC", "ETH", "SOL", "ADA", "DOT", "LINK", "UNI", "AAVE", "MATIC", "AVAX",
        "XRP", "DOGE", "SHIB", "LTC", "BCH", "ATOM", "NEAR", "FTM", "ALGO", "XLM",
    }
    return "crypto" if upper.split("/")[0] in crypto_bases else "equity"
