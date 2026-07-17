---
schema_version: 4
name: REPLACE-ME-kebab-case
status: research
created: YYYY-MM-DD
hypothesis: |
  One paragraph stating the market inefficiency this algo intends to capture
  and the mechanism it uses. Treat this as the single sentence you would say
  to a colleague who asked "what is this trying to do?".
scope:
  asset_class: equities       # equities | crypto | futures | fx | options | mixed
  universe: [SYM1, SYM2]
  horizon: days               # intraday | days | weeks | months
strategy:
  bar_interval: 1d
  type: custom
  direction: long
  entry_signal: Replace with the causal entry rule.
  risk_profile: moderate
  max_drawdown_pct: 15
  backtest_window: 6mo
  success_metric: Positive stitched OOS return and Sharpe.
risk_contract:
  sizing_stop_distance_pct: 2
  protective_stop:
    mode: none                # none | strategy_next_open | engine_stop (currently unsupported)
  drawdown:
    mode: halt_and_flatten_next_open
    limit_pct: 15
  max_positions: 1
exit_conditions: |
  - Time stop: ...
  - Price stop: ...
  - Thesis stop: ...
questionnaire:
  - { id: market_universe, question: "What market and symbol?", answer: "", status: skipped }
  - { id: timeframe_bar_interval, question: "What timeframe?", answer: "", status: skipped }
  - { id: strategy_family, question: "What strategy family?", answer: "", status: skipped }
  - { id: directional_thesis_regime, question: "What direction and regime?", answer: "", status: skipped }
  - { id: entry_signal_idea, question: "What entry signal?", answer: "", status: skipped }
  - { id: exit_invalidation_rules, question: "What exit and invalidation rules?", answer: "", status: skipped }
  - { id: risk_tolerance_max_drawdown, question: "What risk and drawdown limit?", answer: "", status: skipped }
  - { id: backtest_window_success_metric, question: "What test window and success metric?", answer: "", status: skipped }
---

# REPLACE-ME

Rationale, sources, links, anything that helps a future reader or agent
understand *why* this algorithm exists. The frontmatter above is the
machine-read contract; this body is for humans and LLMs reading the folder
cold.
