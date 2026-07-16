---
name: finny-provider-polygon
description: Polygon and Massive market data recipe for Finny Data Agent equity and ETF aggregate OHLCV extraction. Use when POLYGON_API_KEY is available, when the request mentions Polygon or Massive, or when Alpaca fails and Finny should try Polygon before yfinance.
---

# Polygon Provider

Use for equities and ETFs when `POLYGON_API_KEY` is present. Do not read `.env` files; check the key through bash environment only.

Endpoint:

```text
https://api.polygon.io/v2/aggs/ticker/{symbol}/range/{multiplier}/{timespan}/{from}/{to}
```

Interval map:

```text
1d -> 1/day
1h -> 1/hour
30m -> 30/minute
15m -> 15/minute
5m -> 5/minute
1m, 1min -> 1/minute
```

Use `adjusted=true`, `sort=asc`, and `limit=50000`. Follow `next_url` until exhausted, adding `apiKey` to `next_url` when Polygon omits it.

Free Stocks Basic is mainly useful for end-of-day aggregate bars. Intraday aggregates may require a paid tier. Treat HTTP 401/403, entitlement, plan, forbidden, no-access, or limit messages as source failures:

```text
source_attempts: polygon=http_status 403 entitlement/plan limit
```

Do not write a Polygon CSV for entitlement or plan-limit failures. Fall back to the next configured provider. If bars are returned, write only the standard Finny OHLCV CSV. After verification and optional analysis, call `finny_dataset_evidence_finalize` once with the relative CSV path, actual feed/venue/provider symbol, and `adjusted=true` price/corporate-action treatment. Never write or patch the manifest yourself; the runtime owns DatasetEvidenceV2 identity, calendar reconciliation, hashes, quality, qualification, and lineage.
