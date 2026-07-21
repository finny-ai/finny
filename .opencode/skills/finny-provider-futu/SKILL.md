---
name: finny-provider-futu
description: Futu OpenD recipe for exact Hong Kong and mainland China OHLCV extraction for Finny regional equity requests.
---

# Futu Provider

Use only for exact `.HK`, `.SS`, and `.SZ` requests. Preserve request identity and convert only at the provider boundary: `0700.HK`→`HK.00700`, `600519.SS`→`SH.600519`, and `000001.SZ`→`SZ.000001`. Never substitute a US listing, ADR, ETF, or proxy.

Require a reachable Futu OpenD at `FUTU_HOST`/`FUTU_PORT`. Historical quotes do not require the trading unlock password; never unlock trading during data extraction. Use the already-installed `futu-api` package only and never install packages from the Data Agent.

Call `request_history_kline` with the exact Futu code, immutable start/end, requested K-line type, and `max_count=1000`. Continue with `page_req_key` until exhausted or the requested end is covered. Preserve Beijing/Hong Kong timestamp semantics, normalize to UTC, de-duplicate, and drop the still-open candle. Treat historical-candlestick quota or market-right failures as provider blockers.

Write one normalized OHLCV CSV, verify it, then call `finny_dataset_evidence_finalize` exactly once with provider `futu`, feed `opend-history-kline`, venue `HKEX`, `SSE`, or `SZSE`, and the exact Futu code. Regional calendar evidence remains provider-observed and research-only.

If OpenD, quota, entitlement, identity, or coverage fails, record the Futu attempt and fall back to `finny-provider-yfinance` with the unchanged `.HK`/`.SS`/`.SZ` ticker.
