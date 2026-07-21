---
name: finny-provider-zerodha
description: Zerodha Kite Connect recipe for exact NSE and BSE OHLCV extraction for Finny regional equity requests.
---

# Zerodha Provider

Use only for exact `.NS` (NSE) and `.BO` (BSE) requests. Preserve the requested ticker in request identity and convert only at the provider boundary: `RELIANCE.NS` becomes `NSE:RELIANCE`; `500325.BO` becomes `BSE:500325`. Never substitute an ADR, ETF, or US listing.

Require `KITE_API_KEY` and `KITE_ACCESS_TOKEN`; use `KITE_ENDPOINT` or `https://api.kite.trade`. Do not print either credential. Fetch `/instruments/{exchange}` once, locate an exact `tradingsymbol`, and retain its `instrument_token`. Fail on zero or ambiguous matches.

Fetch `/instruments/historical/{instrument_token}/{interval}` with the requested inclusive window. Map Finny intervals to Kite intervals (`1min`→`minute`, `5min`→`5minute`, `15min`→`15minute`, `30min`→`30minute`, `1h`→`60minute`, `1d`→`day`); return a provider-limit blocker for unsupported `4h`. Split the request into bounded windows when necessary and de-duplicate timestamps after pagination. Drop the still-open candle.

Write one normalized `timestamp,open,high,low,close,volume` CSV, verify it, then call `finny_dataset_evidence_finalize` exactly once with provider `zerodha`, feed `kite-historical`, venue `NSE` or `BSE`, and provider symbol `EXCHANGE:TRADINGSYMBOL`. Regional calendar evidence remains provider-observed and research-only.

If credentials, instrument identity, entitlement, or coverage fail, record the Zerodha attempt and fall back to `finny-provider-yfinance` with the unchanged `.NS`/`.BO` ticker.
