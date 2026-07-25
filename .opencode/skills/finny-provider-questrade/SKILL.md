---
name: finny-provider-questrade
description: Questrade API recipe for exact TSX and TSX Venture OHLCV extraction for Finny regional equity requests.
---

# Questrade Provider

Use only for exact `.TO` (TSX) and `.V` (TSX Venture) requests. Preserve the requested ticker; never substitute a US dual listing, ADR, ETF, or proxy.

Require `QUESTRADE_ACCESS_TOKEN` and use `QUESTRADE_API_SERVER`. The token is intentionally an access token, not a refresh token: the Data Agent must not rotate or overwrite user credentials. Do not print it. Search the symbols endpoint for the exact listing, require a unique exchange-consistent result, and retain the numeric symbol ID.

Fetch `v1/markets/candles/{id}` with `startTime`, `endTime`, and the requested granularity. Questrade returns at most 2,000 candles per response, so split the immutable request window into non-overlapping chunks until covered, then sort and de-duplicate timestamps. Drop the still-open candle.

Write one normalized OHLCV CSV, verify it, then call `finny_dataset_evidence_finalize` exactly once with provider `questrade`, feed `markets-candles`, venue `TSX` or `TSXV`, and the exact provider symbol. Regional calendar evidence remains provider-observed and research-only.

If the short-lived token, exact identity, entitlement, or coverage fails, record the Questrade attempt and fall back to `finny-provider-yfinance` with the unchanged `.TO`/`.V` ticker.
