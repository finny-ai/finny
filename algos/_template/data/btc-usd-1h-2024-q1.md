---
schema_version: 2
---

# BTC/USD 1h — 2024-01-01 → 2024-04-01

## Request Identity

| Field                    | Value                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| requested_symbol         | BTC.USD                                                                                                                                        |
| requested_interval       | 1h                                                                                                                                             |
| requested_asset_class    | crypto                                                                                                                                         |
| requested_start          | 2024-01-01                                                                                                                                     |
| requested_end            | 2024-04-01                                                                                                                                     |
| actual_symbol            | BTC/USD                                                                                                                                        |
| actual_interval          | 1h                                                                                                                                             |
| requested_algorithm_name | btc-bollinger-reversion                                                                                                                        |
| run_id                   | e790e6df-0700-4dd5-b618-23a10dc241e8                                                                                                           |
| artifact_paths           | `/Users/jaiminpatel/.local/share/finny/algos/btc-bollinger-reversion.15.6.23.52.294d5c2a/data/crypto/BTC-USD_1h_2024-01-01_2024-04-01.parquet` |

## Source & Coverage

- **Source:** Binance (selected automatically)
- **Total bars:** 2,185
- **Coverage:** 100% — no gaps, no OHLC violations, no outliers
- **Data quality excellent:** no missing data points

## Price Statistics

| Metric             | Value                              |
| ------------------ | ---------------------------------- |
| First close        | $44,219                            |
| Last close         | ~$71,360 (est. from +67.5% return) |
| Mean close         | ~$51,058                           |
| Median close       | $51,058.2                          |
| Min close          | $38,555                            |
| Max close          | $73,777                            |
| Std Dev (ann. vol) | 55.67%                             |

## Performance Metrics

| Metric          | Value                |
| --------------- | -------------------- |
| Total Return    | +67.52%              |
| CAGR            | N/A (3-month window) |
| Ann. Volatility | 55.67%               |
| Max Drawdown    | -20.18%              |

## Regime

**Trending-up** (high confidence) — BTC rallied sharply from ~$38.5K to ~$73.8K over Q1 2024, driven by spot ETF approvals and pre-halving momentum.

## Notable Observations

1. **Strong uptrend** — +67.5% in 3 months with only a single -20.2% drawdown.
2. **Volatility clusters** — 55.67% annualized vol suggests high intraday/bar-level variance, typical for crypto bull runs.
3. **Large max DD (-20.2%)** — any mean-reversion strategy targeting this period needs wide stops (3–4.5%) or a trend-following bias to survive the shakeouts.
4. **Bollinger strategy fit:** Bollinger Bands mean-reversion is counter-indicated by the strong trending-up regime; a pullback-entry or momentum-continuation variant would align better. Suggested lookback 12–20 bars, width 2.5–3.0σ to handle the elevated vol.
