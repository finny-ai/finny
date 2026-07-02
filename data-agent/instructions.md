## Data Source Instructions

This file is the main source cookbook for Finny's Data Agent. It tells the agent
how to connect to data sources with host `bash` and defines the stable artifact
contract that every source recipe must follow. The runtime-injected context remains
the authority for each specific request.

Run write commands with `workdir` set to the active algorithm `data/` directory. Use
literal output paths such as `stock/AAPL_1d_2024-01-01_2024-12-31.csv`; do not hide
write paths behind shell variables when redirecting output.

## Runtime Contract

The runtime-injected `Data request context` is authoritative. Use this cookbook only
after parsing that context. Recipes must be parameterized with the requested symbol
or universe, interval, absolute start date, absolute end date, asset class, and active
`allowed_data_dir`.
Treat `workspace_slug` as the storage workspace only. If
`requested_algorithm_name` is present, use that value for identity metadata; do
not replace it with the workspace slug.

Do not read `algos/_template/README.md` for data extraction. Do not write into
repo-local `algos/_template` or another algorithm's `data/` tree. If a recipe writes
files, set bash `workdir` to `allowed_data_dir` and write relative paths under one of
the market folders below.

Always keep requested coverage separate from actual saved coverage. If a provider
truncates intraday history, returns no rows for part of the window, or rejects the
requested lookback, keep `requested_start` and `requested_end` unchanged in the
manifest, compute `actual_start` and `actual_end` from saved rows, set coverage to
`"partial"`, and include a short coverage note.

## Environment

Real local credentials belong in `.env`, not in this file. Copy `.env.example` to
`.env` and fill only the variables needed by the selected source.

Finny also stores brokerage API keys in local Auth storage when you connect an
account via **Settings → Brokerages**. The Data Agent bash runtime injects the
first connected Alpaca account into the process environment as
`ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` when they are not already set in
`.env`. Do not read `.env` or Auth files directly; test with:

```bash
test -n "${ALPACA_API_KEY_ID:-}" && test -n "${ALPACA_API_SECRET_KEY:-}"
```

Relevant variables:

```text
MARKET_DATA_URL=
MARKET_DATA_TOKEN=
BINANCE_BASE_URL=https://data-api.binance.vision
POLYGON_API_KEY=
ALPACA_API_KEY_ID=
ALPACA_API_SECRET_KEY=
ALPACA_DATA_FEED=iex
ORACLE_DSN=
ORACLE_USER=
ORACLE_PASSWORD=
BLOOMBERG_HOST=
BLOOMBERG_API_KEY=
```

Public yfinance and Binance spot klines do not require API keys. Finny injects
`BINANCE_BASE_URL=https://data-api.binance.vision` into every Data Agent shell,
so users need no local setup. An explicit environment value may override the
application default. Prefer the configured value, then try `https://api.binance.com` and
`https://data-api.binance.vision` before falling back to another provider.

## Source Selection

Use the source requested in the task or mission when it is explicit. Otherwise:

1. Use enterprise/internal instructions when a matching source is configured.
2. Use Binance public klines for crypto spot pairs such as `BTC/USD`. Load
   `finny-provider-binance` before the first Binance fetch when the skill tool
   is available.
3. For **equities and ETFs**, when both `ALPACA_API_KEY_ID` and
   `ALPACA_API_SECRET_KEY` are present in the bash environment, **try Alpaca
   first** before any public fallback.
4. For **equities and ETFs**, when `POLYGON_API_KEY` is present, use Polygon
   aggregate bars after Alpaca and before yfinance. The free Stocks Basic plan
   is useful for end-of-day aggregate bars; intraday requests may require a paid
   Stocks tier, so record entitlement/lookback errors and fall back instead of
   treating a short Polygon response as full-window evidence. Load
   `finny-provider-polygon` before the first Polygon fetch when the skill tool
   is available.
5. Use yfinance for public equities, ETFs, futures roots, and fallback public
   OHLCV when Alpaca is unavailable, fails, or returns unusable coverage.
   If Python `yfinance` is unavailable, use the same Yahoo source through the
   v8 chart HTTP API with Python stdlib `urllib.request`; do not try the v7 CSV
   download endpoint first because it often requires Yahoo auth. Load
   `finny-provider-yfinance` before the first yfinance/Yahoo fetch when the
   skill tool is available.

If a selected source is unavailable because a CLI, Python package, or credential is
missing, report that source error and try the next appropriate configured source.
Do not install packages during extraction. Package installation changes the
runtime and adds noisy, non-reproducible demo behavior; treat missing packages
as a source/runtime availability blocker or fallback reason.
Use heredoc/stdin for short helper scripts. Do not write helper scripts to `/tmp`
or call generic `write`; guarded `bash` is the only write path.

## Alpaca-First With yfinance Fallback (Equity/ETF)

For equity/ETF requests, detect Alpaca credentials from the bash environment
without reading `.env` files:

```bash
test -n "${ALPACA_API_KEY_ID:-}" && test -n "${ALPACA_API_SECRET_KEY:-}"
```

When both are set:

1. **Fetch from Alpaca first** using the Alpaca recipe below. Alpaca supports
   multi-month sub-hour equity history (for example `5Min` over 90 days) when
   credentials are valid. Paginate with `next_page_token` until exhausted.
2. **Verify the Alpaca result** before accepting it:
   - row count is greater than zero
   - `actual_start` / `actual_end` are computed from saved rows
   - for full-window parent requests, coverage is not materially short of
     `requested_start` / `requested_end` (weekend/holiday endpoint gaps and a
     missing current-day open candle are `trading_day_complete`, not failures)
   - no material quality blockers (`duplicates`, `invalid_ohlc`, large session
     gaps) that make the window unusable
3. If Alpaca fails (missing creds, HTTP/auth error, empty window, partial
   coverage for a full-window request, or failed verification), **record the
   Alpaca attempt and fall back to Polygon when `POLYGON_API_KEY` is available,
   otherwise yfinance**. A window short only by the current day's still-open
   bar is `trading_day_complete`, not partial coverage — accept the Alpaca
   result instead of falling back.
4. If Polygon fails because the free plan does not cover the requested interval,
   date range, or entitlement, record the Polygon attempt and fall back to yfinance
   only when yfinance can provide usable coverage.
5. If the attempted sources cannot cover the requested window, return
   `BLOCKED: requested evidence window unavailable` with all source attempts.

When Alpaca credentials are **not** present, try Polygon first when
`POLYGON_API_KEY` is present; otherwise skip straight to yfinance (and other
configured sources) using the rules below. Do not return a yfinance-only blocker
before checking whether Alpaca or Polygon credentials exist in bash.

## Provider Capability Preflight

Before running a fetch, compare the requested asset class, interval, and date span
with known source limits. This is a guardrail, not a backtest shortcut.

- Public yfinance equity/ETF intraday history is limited. Treat sub-hour
  intervals over roughly 60 calendar days, including `5min` over `3m`, as unable
  to provide full-window validation evidence **when Alpaca and other configured
  paid/internal sources are unavailable or have already failed verification**.
- When Alpaca credentials are present for an equity/ETF request, **do not**
  hard-stop on the yfinance 60-day intraday limit before attempting Alpaca.
- When `POLYGON_API_KEY` is present for an equity/ETF request, **do not**
  hard-stop on the yfinance 60-day intraday limit before attempting Polygon.
  If the key is on the free Stocks Basic plan and Polygon rejects intraday bars,
  record that as `provider_limit` or `auth_entitlement` and continue fallback.
- If Alpaca, Polygon, Oracle, Bloomberg, or an internal HTTP source is configured
  for the requested market and can cover the window, use that source first.
- If only a limited public fallback remains after Alpaca (or other configured
  sources) fail, do not make repeated doomed yfinance retries. Return
  `BLOCKED: requested evidence window unavailable`, include the requested_start/
  requested_end, the requested interval, each attempted source, and why fallback
  could not cover the window.
- Optional diagnostic partial files may be written only when useful, but mark
  `coverage` as `"partial"` and `usable_for_parent` as `"no"` for full-window
  validation/backtest requests unless trading-day-complete rules apply.

## Output Convention

Write OHLCV CSV columns in this order:

```text
timestamp,open,high,low,close,volume
```

Use the closest existing folder:

```text
stock/<SYMBOL>_<INTERVAL>_<START>_<END>.csv
crypto/<SYMBOL>_<INTERVAL>_<START>_<END>.csv
future/<SYMBOL>_<INTERVAL>_<START>_<END>.csv
option/<SYMBOL>_<INTERVAL>_<START>_<END>.csv
```

For durable artifacts, write a small `.manifest.json` sidecar when practical. Every
successful extraction must write both CSV and manifest under `allowed_data_dir` only.
Include identity fields that match the digest:

```json
{
  "schema_version": 1,
  "source": "yfinance",
  "symbols": ["AAPL"],
  "interval": "1d",
  "requested_symbol": "AAPL",
  "actual_symbol": "AAPL",
  "requested_interval": "1d",
  "actual_interval": "1d",
  "requested_asset_class": "equity",
  "actual_asset_class": "equity",
  "requested_algorithm_name": "aapl-breakout",
  "requested_start": "2024-01-01",
  "requested_end": "2024-12-31",
  "actual_start": "2024-01-02",
  "actual_end": "2024-12-30",
  "output_path": "stock/AAPL_1d_2024-01-01_2024-12-31.csv",
  "rows": 252,
  "run_id": "20260616T120000Z-aapl",
  "coverage": "partial",
  "coverage_note": "source did not return requested boundary dates",
  "usable_for_parent": "no",
  "created_at": "2026-06-04T00:00:00Z"
}
```

The manifest may also carry optional, lenient enrichment fields written by the
`Analysis Summary` step (`analysis_summary_path`, `analysis_regime`,
`analysis_hypotheses`). These are candidate analysis only; they never affect identity,
coverage, or reuse, and may be absent.

Use `actual_start`/`actual_end` from the first and last saved row after timezone
normalization and deduplication. Use `requested_start`/`requested_end` for the
requested window. If a source truncates history, set `coverage` to `"partial"`
and include a concise `coverage_note`; do not label requested dates as actual
coverage.
If `actual_end` is before `requested_end` only because the requested end falls on
a weekend/market holiday and the saved rows include the last trading day before
that date, set `coverage` to `"trading_day_complete"` and `usable_for_parent` to
`"yes"` with the non-trading-day caveat.
The same rule applies when `requested_end` is the current date and that day's bar
is not yet complete. Providers (Alpaca, Polygon, yfinance/Yahoo) publish a daily
bar only after the session closes, so a `1d` request ending today can never
include today's row while the session is open or before it starts. If the saved
rows reach the last completed trading day before `requested_end`, set `coverage`
to `"trading_day_complete"` and `usable_for_parent` to `"yes"` with an
open-candle caveat in `coverage_note`. Do not mark this `"partial"` /
`usable_for_parent: no`, and do not spend fallback attempts on other providers
hunting for the current day's bar — no source has it until the session closes.

Do not store command text, credential names, or secret values in manifests.

## Strict Quality Vocabulary

Use the same labels in verification summaries and digests that strict backtests use:
`duplicates`, `gaps`, `invalid_ohlc`, `zero_volume`, `outliers`,
`partial_provider_coverage`. Set `usable_for_parent: no` when any blocker is
material for the parent's requested window. Do not estimate missing summary stats;
return `not_returned` instead of guessing mean, std dev, first/last close, or CAGR.

## Python Runtime

Prefer `$FINNY_MANAGED_PYTHON` or `$FINNY_PYTHON_BIN` when exported into bash.
When either variable is set, use it for every Python invocation instead of bare
`python3`/`python` so the workspace `.venv` packages (yfinance, pandas, etc.) are
available. Example: `"$FINNY_PYTHON_BIN" <<'PY'` or `"$FINNY_PYTHON_BIN" -c '...'`.
Do not run `pip`, `pip3`, `brew install`, or package installs during extraction.
If Python or a required import is unavailable, return
`BLOCKED: runtime/source unavailable` for that source and try the next configured
source. On macOS/homebrew failures (for example Python 3.14 ABI issues), report the
clean blocker instead of retrying installs.

## Provider Limits

When the parent requires full-window evidence and Alpaca (or another configured
paid/internal source) is available, try that source first and verify coverage.
Only when every configured source fails should you hard-stop. When the parent
requires full-window evidence and **only** public yfinance remains after Alpaca
and other configured sources fail, hard-stop before saving a partial public fetch.
Example: SPY 5m over three months with no Alpaca credentials should return
`BLOCKED: provider limit` with the source error instead of writing truncated
OHLCV and marking it usable.

## Artifact Verification

After writing a CSV and manifest, run a local verification command that reads both
files back from `allowed_data_dir`. At minimum, verify:

- row count is greater than zero
- the manifest output path points to the saved CSV
- requested_start/requested_end match the request context
- actual_start/actual_end match the first and last saved timestamps
- timestamp duplicates, null OHLCV values, invalid OHLC relationships, and large
  intraday gaps are reported when practical

Valid OHLC for each bar requires `high >= low`, `high >= max(open, close)`, and
`low <= min(open, close)`. Bullish and bearish candles are both valid.

Verification example (stdlib):

```bash
"$FINNY_PYTHON_BIN" <<'PY'
import csv

def valid_ohlc(o, h, l, c):
    body_top = max(o, c)
    body_bottom = min(o, c)
    return h >= l and h >= body_top and l <= body_bottom

invalid_ohlc = 0
rows = 0
with open("stock/AAPL_5m_2026-03-16_2026-06-15.csv", newline="") as f:
    for row in csv.DictReader(f):
        rows += 1
        o, h, l, c = float(row["open"]), float(row["high"]), float(row["low"]), float(row["close"])
        if not valid_ohlc(o, h, l, c):
            invalid_ohlc += 1
print(f"rows={rows} invalid_ohlc={invalid_ohlc}")
PY
```

Return the verification summary to the parent. Do not dump raw rows or full gap arrays; report counts and at most three sample timestamps/gaps.

## Analysis Summary

After a usable extraction passes verification, write one more sidecar next to the CSV and
manifest: `<base>.analysis_summary.json`. This is **candidate edge analysis, not confirmed
edge** — it gives the parent a starting hypothesis, and every claim must be backtested before
it is trusted. It never changes coverage, `usable_for_parent`, or identity.

Compute only what the saved rows support: total return, max drawdown, realized (annualized)
volatility, a coarse volume regime, one regime label, and 1-3 candidate hypotheses. Use the
recipe below as-is; do not invent different math. If `pandas` is unavailable or the
computation raises, skip the sidecar, report `not_returned` for the analysis digest fields,
and continue — never block extraction on this step.

Schema written to `<base>.analysis_summary.json`:

```json
{
  "schema_version": 1,
  "source_csv": "stock/SPY_1h_2026-01-01_2026-03-31.csv",
  "source_manifest": "stock/SPY_1h_2026-01-01_2026-03-31.manifest.json",
  "analysis_regime": "trending_up",
  "analysis_hypotheses": [
    "Candidate trend continuation after shallow pullbacks; requires backtest."
  ],
  "stats": {
    "total_return_pct": 4.2,
    "max_drawdown_pct": -1.8,
    "realized_volatility": 0.21,
    "volume_regime": "normal"
  },
  "created_at": "2026-06-25T00:00:00Z"
}
```

Use `not_returned` for any stat that cannot be computed. `analysis_regime` is one of
`trending_up`, `trending_down`, `range_bound`, `high_volatility`, `low_liquidity`, `mixed`.
Hypotheses are phrased as `Candidate ... ; requires backtest` — never "edge", "profitable",
or "works".

Recipe (substitute the literal CSV/manifest paths for this request):

```bash
"$FINNY_PYTHON_BIN" <<'PY'
import json, datetime
import numpy as np, pandas as pd

CSV = "stock/SPY_1h_2026-01-01_2026-03-31.csv"
MANIFEST = "stock/SPY_1h_2026-01-01_2026-03-31.manifest.json"
INTERVAL = "1h"
OUT = CSV.rsplit(".csv", 1)[0] + ".analysis_summary.json"

df = pd.read_csv(CSV)
c = pd.to_numeric(df["close"], errors="coerce").to_numpy()
v = pd.to_numeric(df["volume"], errors="coerce").to_numpy()
c = c[np.isfinite(c)]

NR = "not_returned"
total_return_pct = max_dd_pct = realized_vol = NR
volume_regime = NR

if c.size >= 2 and c[0] > 0:
    total_return_pct = round(float(c[-1] / c[0] - 1) * 100, 4)
    peak = np.maximum.accumulate(c)
    dd = (c - peak) / np.where(peak > 0, peak, 1)
    max_dd_pct = round(float(dd.min()) * 100, 4)
    logret = np.diff(np.log(np.clip(c, 1e-12, None)))
    ann = {"1m":525600,"5m":105120,"15m":35040,"30m":17520,"1h":8760,"4h":2190,"1d":365}.get(INTERVAL, 365)
    if logret.size > 1:
        realized_vol = round(float(np.std(logret, ddof=1) * np.sqrt(ann)), 4)

vfin = v[np.isfinite(v)]
# No volume column (e.g. some forex/crypto feeds) means unknown, not 100% zero —
# default to 0.0 so the low-liquidity guard does not override the trend analysis.
zero_share = float(np.mean(vfin <= 0)) if vfin.size else 0.0
if vfin.size >= 10:
    tail = vfin[-max(1, vfin.size // 5):]
    ratio = float(np.mean(tail) / np.mean(vfin)) if np.mean(vfin) > 0 else 1.0
    volume_regime = "elevated" if ratio >= 1.25 else "thin" if ratio <= 0.75 else "normal"

# Coarse regime: trend via log-price linear fit (R^2 + slope), vol band, liquidity guard.
regime = "mixed"
if c.size >= 5:
    x = np.arange(c.size, dtype=float)
    y = np.log(np.clip(c, 1e-12, None))
    coeffs = np.polyfit(x, y, 1)
    slope = float(coeffs[0])
    fit = np.polyval(coeffs, x)
    ss_res = float(np.sum((y - fit) ** 2)); ss_tot = float(np.sum((y - y.mean()) ** 2))
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    ret = (total_return_pct / 100) if total_return_pct != NR else 0.0
    rv = realized_vol if realized_vol != NR else 0.0
    if zero_share >= 0.2:
        regime = "low_liquidity"
    elif rv and rv > 0.6:
        regime = "high_volatility"
    elif r2 >= 0.3 and slope > 0:
        regime = "trending_up"
    elif r2 >= 0.3 and slope < 0:
        regime = "trending_down"
    elif r2 < 0.1 and abs(ret) < 0.05:
        regime = "range_bound"

HYP = {
    "trending_up": ["Candidate trend continuation after shallow pullbacks; requires backtest.",
                    "Candidate breakouts above prior swing highs; requires backtest."],
    "trending_down": ["Candidate short rallies into resistance; requires backtest.",
                      "Candidate breakdown continuation below prior swing lows; requires backtest."],
    "range_bound": ["Candidate mean reversion from range extremes; requires backtest.",
                    "Candidate fades of failed breakouts; requires backtest."],
    "high_volatility": ["Candidate volatility-breakout entries with wider stops; requires backtest.",
                        "Candidate reduced position size during high-vol regime; requires backtest."],
    "low_liquidity": ["Candidate liquidity-aware entries avoiding thin sessions; requires backtest."],
    "mixed": ["Candidate regime-filtered entries before committing to a direction; requires backtest."],
}
hypotheses = HYP[regime][:3]

summary = {
    "schema_version": 1,
    "source_csv": CSV,
    "source_manifest": MANIFEST,
    "analysis_regime": regime,
    "analysis_hypotheses": hypotheses,
    "stats": {
        "total_return_pct": total_return_pct,
        "max_drawdown_pct": max_dd_pct,
        "realized_volatility": realized_vol,
        "volume_regime": volume_regime,
    },
    "created_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
with open(OUT, "w") as f:
    json.dump(summary, f, indent=2)

# Mirror the headline fields + pointer into the manifest so the parent sees them.
try:
    with open(MANIFEST) as f:
        man = json.load(f)
    man["analysis_summary_path"] = OUT
    man["analysis_regime"] = regime
    man["analysis_hypotheses"] = hypotheses
    with open(MANIFEST, "w") as f:
        json.dump(man, f, indent=2)
except Exception as e:
    print(f"analysis summary written, manifest not updated: {e}")

print(f"analysis_summary_path={OUT} analysis_regime={regime}")
PY
```

## yfinance

Use yfinance for public equities, ETFs, futures roots, and public fallback OHLCV.
This recipe requires the host Python environment to have `yfinance` and `pandas`
available.

Public yfinance is a fallback source, not the preferred production feed when paid
or internal market data is configured. If yfinance is selected as the fallback, try
the requested window first. For intraday intervals, yfinance may reject long
lookbacks; when the provider-capability preflight already proves the full window
cannot be covered, do not retry repeatedly. Return the full-window blocker, or make
one diagnostic partial attempt only if it will help explain coverage, and record
the limitation in the manifest.

Example: AAPL daily bars.

```bash
"${FINNY_PYTHON_BIN:-python3}" -c 'import sys, pandas as pd, yfinance as yf
df = yf.Ticker("AAPL").history(start="2024-01-01", end="2024-12-31", interval="1d").reset_index()
df = df.rename(columns={"Date":"timestamp","Datetime":"timestamp","Open":"open","High":"high","Low":"low","Close":"close","Volume":"volume"})
df[["timestamp","open","high","low","close","volume"]].to_csv(sys.stdout, index=False)' \
  > stock/AAPL_1d_2024-01-01_2024-12-31.csv
```

Manifest:

```bash
"${FINNY_PYTHON_BIN:-python3}" -c 'import json, datetime, pandas as pd
df = pd.read_csv("stock/AAPL_1d_2024-01-01_2024-12-31.csv", parse_dates=["timestamp"])
actual_start = df["timestamp"].min().date().isoformat()
actual_end = df["timestamp"].max().date().isoformat()
coverage = "complete" if actual_start <= "2024-01-01" and actual_end >= "2024-12-31" else "partial"
print(json.dumps({"schema_version":1,"source":"yfinance","symbols":["AAPL"],"interval":"1d","requested_start":"2024-01-01","requested_end":"2024-12-31","actual_start":actual_start,"actual_end":actual_end,"output_path":"stock/AAPL_1d_2024-01-01_2024-12-31.csv","rows":len(df),"coverage":coverage,"created_at":datetime.datetime.utcnow().replace(microsecond=0).isoformat()+"Z"}, indent=2))' \
  > stock/AAPL_1d_2024-01-01_2024-12-31.manifest.json
```

## Binance Public Klines

Use Binance public klines for crypto spot OHLCV. Convert Finny pairs to Binance
symbols: `BTC/USD` -> `BTCUSDT`, `ETH/USD` -> `ETHUSDT`.

Public klines need no API key or signed headers. Use
`${BINANCE_BASE_URL:-https://api.binance.com}/api/v3/klines`. On DNS failure,
connection timeout, HTTP 403, or HTTP 451, retry transient failures with bounded
backoff and try the alternate public host `https://data-api.binance.vision`
before using yfinance. Record every attempted host and failure in
`source_attempts`. Do not describe a fallback result as successful evidence
unless its coverage and quality pass verification.

Binance returns at most 1000 klines per request. That is a page size, not a
lookback limit. For any requested window that can exceed 1000 bars, page forward
until the requested end is reached, de-duplicate by open time, and only then
compute actual coverage. Do not report `partial_provider_coverage` just because
the first response had 1000 rows.

For 1h data, 90 days is roughly 2160 bars and must be collected in multiple
requests. Continue with `startTime = last_open_time + interval_ms`; stop only
when the next page is empty, the cursor reaches requested_end, or Binance returns
an actual API error.

Example: BTC/USD daily bars.

```bash
START_MS=$(python -c 'import datetime; print(int(datetime.datetime.fromisoformat("2024-01-01").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000))')
END_MS=$(python -c 'import datetime; print(int(datetime.datetime.fromisoformat("2024-12-31").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000))')
curl -fsS "${BINANCE_BASE_URL:-https://api.binance.com}/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime=${START_MS}&endTime=${END_MS}&limit=1000" \
  | python -c 'import csv, json, sys
rows = json.load(sys.stdin)
w = csv.writer(sys.stdout)
w.writerow(["timestamp","open","high","low","close","volume"])
for r in rows:
    w.writerow([r[0], r[1], r[2], r[3], r[4], r[5]])' \
  > crypto/BTC-USD_1d_2024-01-01_2024-12-31.csv
```

## Alpaca Market Data

Use Alpaca for equities/options when credentials are present in the bash
environment. For equity/ETF OHLCV this is the **preferred first source**; fall
back to yfinance only when Alpaca is unavailable or verification shows unusable
coverage/quality.

Required variables:

```text
ALPACA_API_KEY_ID=
ALPACA_API_SECRET_KEY=
ALPACA_DATA_FEED=iex
```

Map the requested Finny interval exactly to Alpaca: `1m`/`1min` -> `1Min`,
`5m`/`5min` -> `5Min`, `15m`/`15min` -> `15Min`, `30m`/`30min` -> `30Min`,
`1h` -> `1Hour`, and `1d` -> `1Day`. Never substitute the `5Min` example for a
different requested interval. Alpaca returns at most 10000 bars per page; follow
`next_page_token` until exhausted before computing actual coverage.

Example: AAPL daily stock bars.

```bash
curl -fsS \
  -H "APCA-API-KEY-ID: ${ALPACA_API_KEY_ID}" \
  -H "APCA-API-SECRET-KEY: ${ALPACA_API_SECRET_KEY}" \
  "https://data.alpaca.markets/v2/stocks/bars?symbols=AAPL&timeframe=1Day&start=2024-01-01T00:00:00Z&end=2024-12-31T00:00:00Z&limit=10000&adjustment=raw&feed=${ALPACA_DATA_FEED:-iex}" \
  | python -c 'import csv, json, sys
payload = json.load(sys.stdin)
rows = (payload.get("bars") or {}).get("AAPL") or []
w = csv.writer(sys.stdout)
w.writerow(["timestamp","open","high","low","close","volume"])
for r in rows:
    w.writerow([r["t"], r["o"], r["h"], r["l"], r["c"], r.get("v", 0)])' \
  > stock/AAPL_1d_2024-01-01_2024-12-31.csv
```

Example: AAPL 5-minute bars with pagination (preferred for multi-month intraday).

```bash
"$FINNY_PYTHON_BIN" <<'PY'
import csv, json, os, sys, urllib.parse, urllib.request
symbol = "AAPL"
timeframe = "5Min"
start = "2026-03-16T00:00:00Z"
end = "2026-06-16T00:00:00Z"
out = "stock/AAPL_5m_2026-03-16_2026-06-16.csv"
feed = os.environ.get("ALPACA_DATA_FEED", "iex")
headers = {
    "APCA-API-KEY-ID": os.environ["ALPACA_API_KEY_ID"],
    "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET_KEY"],
}
rows = []
page_token = None
while True:
    params = {
        "symbols": symbol,
        "timeframe": timeframe,
        "start": start,
        "end": end,
        "limit": "10000",
        "adjustment": "raw",
        "feed": feed,
    }
    if page_token:
        params["page_token"] = page_token
    url = "https://data.alpaca.markets/v2/stocks/bars?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.load(resp)
    bars = (payload.get("bars") or {}).get(symbol) or []
    rows.extend(bars)
    page_token = payload.get("next_page_token")
    if not page_token:
        break
if not rows:
    raise SystemExit("alpaca returned no bars for requested window")
with open(out, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
    for r in rows:
        w.writerow([r["t"], r["o"], r["h"], r["l"], r["c"], r.get("v", 0)])
print(f"wrote {len(rows)} rows to {out}")
PY
```

After Alpaca writes the CSV, verify coverage and timestamp cadence. The shortest
positive intraday timestamp delta must not be smaller than the requested interval;
for example, a `15m` request containing 5-minute deltas is unusable even if its
filename and manifest say `15m`. Echo the exact CSV and manifest paths that were
read back; do not reconstruct or retype them from memory. If verification fails, delete or
ignore the Alpaca artifact for the final manifest and retry with Polygon when
configured, otherwise yfinance. Record `source_attempts` and the fallback reason
in the return summary.

For options, use Alpaca's options bars endpoint and OCC-formatted symbols. Add the
exact option symbol mapping to this file when an enterprise fork needs options data.

## Polygon Market Data

Use Polygon aggregate bars for equities and ETFs when `POLYGON_API_KEY` is present.
For the initial free-plan integration, treat Polygon as the preferred configured
fallback after Alpaca and before yfinance. Polygon's free Stocks Basic plan is
best suited for end-of-day aggregate bars. Intraday bars may require a paid Stocks
tier; if Polygon returns an entitlement, plan, forbidden, or no-access error,
record the exact HTTP status and short error message in `source_attempts`, then
continue to the next fallback. Do not mark a free-plan entitlement failure as a
successful partial extraction.

Required variable:

```text
POLYGON_API_KEY=
```

Map the requested interval to Polygon aggregate parameters: `1d` -> `1/day`,
`1h` -> `1/hour`, `30m` -> `30/minute`, `15m` -> `15/minute`, `5m` -> `5/minute`,
and `1m`/`1min` -> `1/minute`. Keep `adjusted=true`, `sort=asc`, and
`limit=50000`. If more rows may exist, follow Polygon pagination through
`next_url`, adding `apiKey` when the returned URL omits it, until no next page is
available.

Example: SPY daily bars.

```bash
"${FINNY_PYTHON_BIN:-python3}" <<'PY'
import csv, datetime, json, os, sys, urllib.error, urllib.parse, urllib.request

symbol = "SPY"
requested_interval = "1d"
requested_start = "2024-01-01"
requested_end = "2024-12-31"
requested_asset_class = "equity"
requested_algorithm_name = os.environ.get("FINNY_STRATEGY_WORKSPACE_NAME", "polygon-demo")
run_id = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).strftime("%Y%m%dT%H%M%SZ") + "-polygon-spy"
out = "stock/SPY_1d_2024-01-01_2024-12-31.csv"
manifest_out = out.replace(".csv", ".manifest.json")

interval_map = {
    "1d": ("1", "day"),
    "1day": ("1", "day"),
    "1h": ("1", "hour"),
    "1hour": ("1", "hour"),
    "30m": ("30", "minute"),
    "30min": ("30", "minute"),
    "15m": ("15", "minute"),
    "15min": ("15", "minute"),
    "5m": ("5", "minute"),
    "5min": ("5", "minute"),
    "1m": ("1", "minute"),
    "1min": ("1", "minute"),
}
multiplier, timespan = interval_map[requested_interval.lower()]
api_key = os.environ["POLYGON_API_KEY"]
base = (
    f"https://api.polygon.io/v2/aggs/ticker/{urllib.parse.quote(symbol)}/range/"
    f"{multiplier}/{timespan}/{requested_start}/{requested_end}"
)
params = {"adjusted": "true", "sort": "asc", "limit": "50000", "apiKey": api_key}
url = base + "?" + urllib.parse.urlencode(params)
rows = []
attempts = []

while url:
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        try:
            message = json.loads(body).get("error") or json.loads(body).get("message") or body
        except Exception:
            message = body
        raise SystemExit(f"polygon failed http_status={e.code}: {message}")
    status = str(payload.get("status", "")).upper()
    if status not in {"OK", "DELAYED"}:
        message = payload.get("error") or payload.get("message") or status or "unknown polygon response"
        raise SystemExit(f"polygon failed status={status}: {message}")
    rows.extend(payload.get("results") or [])
    next_url = payload.get("next_url")
    if next_url and "apiKey=" not in next_url:
        next_url += ("&" if "?" in next_url else "?") + urllib.parse.urlencode({"apiKey": api_key})
    url = next_url

if not rows:
    raise SystemExit("polygon returned no bars for requested window")

rows = sorted({int(r["t"]): r for r in rows}.values(), key=lambda r: int(r["t"]))
with open(out, "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["timestamp", "open", "high", "low", "close", "volume"])
    for r in rows:
        ts = datetime.datetime.fromtimestamp(int(r["t"]) / 1000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        w.writerow([ts, r["o"], r["h"], r["l"], r["c"], r.get("v", 0)])

actual_start = datetime.datetime.fromtimestamp(int(rows[0]["t"]) / 1000, tz=datetime.timezone.utc).date().isoformat()
actual_end = datetime.datetime.fromtimestamp(int(rows[-1]["t"]) / 1000, tz=datetime.timezone.utc).date().isoformat()
coverage = "complete" if actual_start <= requested_start and actual_end >= requested_end else "partial"
manifest = {
    "schema_version": 1,
    "source": "polygon",
    "symbols": [symbol],
    "interval": requested_interval,
    "requested_symbol": symbol,
    "actual_symbol": symbol,
    "requested_interval": requested_interval,
    "actual_interval": requested_interval,
    "requested_asset_class": requested_asset_class,
    "actual_asset_class": requested_asset_class,
    "requested_algorithm_name": requested_algorithm_name,
    "requested_start": requested_start,
    "requested_end": requested_end,
    "actual_start": actual_start,
    "actual_end": actual_end,
    "output_path": out,
    "rows": len(rows),
    "run_id": run_id,
    "coverage": coverage,
    "usable_for_parent": "yes" if coverage == "complete" else "no",
    "source_attempts": [{"source": "polygon", "status": "ok", "rows": len(rows)}],
    "created_at": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
}
with open(manifest_out, "w") as f:
    json.dump(manifest, f, indent=2)
print(f"wrote {len(rows)} rows to {out} and {manifest_out}")
PY
```

If Polygon fails with an entitlement or plan-limit error, do not write a Polygon
CSV. Return a blocker only when all appropriate fallbacks are exhausted. A useful
failure summary should include:

```text
source_attempts: polygon=http_status 403 entitlement/plan limit, yfinance=provider limit
usable_for_parent: no
BLOCKED: requested evidence window unavailable
```

## Generic HTTP API

Use this pattern for proprietary HTTP APIs. Keep responses projected to the requested
fields and date window.

```bash
curl -fsS "$MARKET_DATA_URL/bars?symbol=AAPL&interval=1d&start=2024-01-01&end=2024-12-31" \
  -H "Authorization: Bearer $MARKET_DATA_TOKEN" \
  | python -c 'import csv, json, sys
payload = json.load(sys.stdin)
rows = payload.get("bars", [])
w = csv.writer(sys.stdout)
w.writerow(["timestamp","open","high","low","close","volume"])
for r in rows:
    w.writerow([r["timestamp"], r["open"], r["high"], r["low"], r["close"], r["volume"]])' \
  > stock/AAPL_1d_2024-01-01_2024-12-31.csv
```

## Oracle Read-Only SQL

Use this pattern when a quant engineer configures Oracle market bars. Keep SQL
read-only and scoped by symbol, interval, start, and end.

```bash
sqlplus -S "$ORACLE_USER/$ORACLE_PASSWORD@$ORACLE_DSN" <<'SQL' > stock/AAPL_1d_2024-01-01_2024-12-31.csv
set heading off feedback off pagesize 0
select timestamp || ',' || open || ',' || high || ',' || low || ',' || close || ',' || volume
from market_bars
where symbol = 'AAPL'
  and interval = '1d'
  and timestamp >= date '2024-01-01'
  and timestamp < date '2024-12-31'
order by timestamp;
SQL
```

## Bloomberg Or Internal CLIs

Add the enterprise-specific command here. The command should:

- accept symbol, interval, start, and end
- run read-only
- emit `timestamp,open,high,low,close,volume`
- write only under the active algo `data/` directory
- avoid printing credential values
