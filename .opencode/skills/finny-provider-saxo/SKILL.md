---
name: finny-provider-saxo
description: Saxo OpenAPI recipe for exact European listed-equity OHLCV extraction for Finny regional equity requests.
---

# Saxo Provider

Use for exact supported European tickers: `.AS`, `.BR`, `.DE`, `.L`, `.MC`, `.MI`, `.PA`, and `.SW`. Preserve the requested ticker and never substitute an ADR, ETF, US listing, or another venue.

Require `SAXO_ACCESS_TOKEN`; use `SAXO_ACCOUNT_KEY` when supplied and `SAXO_ENDPOINT` or the Saxo simulation OpenAPI endpoint. Do not print tokens. Search `ref/v1/instruments` with `AssetTypes=Stock`, the exact base ticker keyword, and the mapped exchange. Select only a unique result whose returned exchange and symbol match the requested listing; retain its UIC and returned Saxo symbol.

Fetch `chart/v3/charts` for that UIC with `AssetType=Stock`, the requested horizon, and enough samples to cover the immutable window. Follow Saxo pagination/sample limits, reject truncated coverage, drop the still-open sample, and record `DataVersion` when returned because historical chart corrections require refetching.

Write one normalized OHLCV CSV, verify it, then call `finny_dataset_evidence_finalize` exactly once with provider `saxo`, feed `openapi-chart-v3`, the exact returned exchange, and exact Saxo provider symbol. Regional calendar evidence remains provider-observed and research-only.

If credentials, identity, entitlement, or coverage fail, record the Saxo attempt and fall back to `finny-provider-yfinance` with the unchanged European suffix.
