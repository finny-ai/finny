---
name: finny-provider-yfinance
description: yfinance and Yahoo fallback recipe for Finny Data Agent public equity, ETF, futures, and fallback OHLCV extraction. Use when Alpaca and Polygon are unavailable or unusable, or when the source preference explicitly requests yfinance or Yahoo.
---

# yfinance Provider

Use as a public fallback after configured sources such as Alpaca and Polygon are unavailable, fail, or return unusable coverage. Do not repeatedly retry known provider-limit windows.

Prefer `$FINNY_MANAGED_PYTHON` or `$FINNY_PYTHON_BIN` over bare `python3`. Use installed `yfinance` and `pandas` only if already available; never run package installation commands.

Known public constraints:

- Equity and ETF intraday history is limited, often around 60 days for 5-minute bars.
- Long multi-month intraday requests such as `SPY 5m over 3m` should be treated as provider-limited after configured sources have been tried.
- The Yahoo v7 CSV download endpoint often requires auth; if `yfinance` is unavailable, prefer the Yahoo v8 chart HTTP API through Python stdlib `urllib.request`.

Write exactly one OHLCV CSV and one `.manifest.json` sidecar under `allowed_data_dir` only when rows are usable for the requested source attempt. Manifest `source` should be `yfinance` or `yahoo_v8_chart` as appropriate, with requested versus actual coverage, source attempts, quality counts, and `usable_for_parent`.
