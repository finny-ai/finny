---
name: finny-provider-binance
description: Binance public market data recipe for Finny Data Agent crypto OHLCV extraction. Use when fetching BTC/USD, ETH/USD, or other crypto spot bars through Binance public klines, especially when pagination, interval mapping, host fallback, or Finny CSV/manifest output is required.
---

# Binance Provider

Use for public crypto spot OHLCV only. Normalize common Finny symbols to Binance spot symbols: `BTC/USD` and `BTC-USD` -> `BTCUSDT`, `ETH/USD` -> `ETHUSDT`.

Use the configured base first:

```text
${BINANCE_BASE_URL:-https://data-api.binance.vision}/api/v3/klines
```

On DNS, timeout, HTTP 403, or HTTP 451 failures, retry with the alternate public host `https://api.binance.com`, then `https://data-api.binance.vision` if it was not already tried.

Map intervals directly where possible: `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`. Convert requested start/end dates to millisecond `startTime` and `endTime`.

The `limit=1000` response cap is only a page size. Page until the requested end is reached, the source returns no newer rows, or every host fails:

```text
next startTime = last_open_time + interval_ms
```

Write exactly one CSV under `allowed_data_dir` with:

```text
timestamp,open,high,low,close,volume
```

Write a `DatasetEvidenceV2` `.manifest.json` sidecar (`schema: finny.dataset_evidence`, `version: 2`) plus legacy identity fields. Record the Binance host/feed/venue, canonical and provider symbol, raw price basis, 24/7 calendar/version/session/timezone, exact expected/actual/missing/extra timestamp counts and ranges, incomplete-final-candle state, raw/semantic/processed SHA-256 values, transformation versions, and qualification reason codes. Any repair, including a no-op, creates a new evidence ID with lineage and remains research-only. Do not mark a first 1000-row page as partial provider coverage; continue pagination first.
