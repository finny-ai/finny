---
name: finny-provider-alpaca
description: Alpaca market-data recipe for Finny Data Agent equity and ETF OHLCV extraction when Finny has an attached Alpaca brokerage account or injected Alpaca credentials.
---

# Alpaca Provider

Use for equities and ETFs only when the runtime advertises this capability. Credentials are injected into bash as `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY`; never print or persist them.

Fetch `https://data.alpaca.markets/v2/stocks/bars` with the requested symbols, mapped timeframe, inclusive start, and exclusive end bound (requested end date plus one day). Send `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` headers and use `ALPACA_DATA_FEED` when present.

Map Finny intervals as follows: `1m -> 1Min`, `5m -> 5Min`, `15m -> 15Min`, `30m -> 30Min`, `1h -> 1Hour`, and `1d -> 1Day`.

Follow `next_page_token` until it is absent or the full requested window is covered. Normalize returned timestamps to UTC and write only the standard `timestamp,open,high,low,close,volume` CSV under `allowed_data_dir`.

After CSV verification and optional analysis, call `finny_dataset_evidence_finalize` once with the relative CSV path, actual Alpaca feed and venue, provider symbol, and `adjustment=all` price/corporate-action treatment. Never write or patch the manifest yourself; the runtime owns DatasetEvidenceV2 identity, calendar reconciliation, hashes, quality, qualification, and lineage. Treat authentication, subscription/feed, empty-result, and pagination failures as provider failures; do not label them as yfinance retrieval failures.
