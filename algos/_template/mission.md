---
schema_version: 3
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
  bar_interval: 1h
  type: mean-reversion
  direction: long
  entry_signal: "RSI/Bollinger oversold reversal"
  risk_profile: moderate
  max_drawdown_pct: "10"
  backtest_window: "1y"
  success_metric: "positive return with Sharpe > 1 and max drawdown under 10%"
exit_conditions: |
  - Time stop: ...
  - Price stop: ...
  - Thesis stop: ...
questionnaire:
  - id: market_universe
    question: "Which market or universe should this strategy trade?"
    answer: "SYM1, SYM2"
    status: answered
  - id: timeframe_bar_interval
    question: "What trading timeframe and bar interval should this strategy use?"
    answer: "Swing strategy on 1h bars"
    status: answered
  - id: strategy_family
    question: "What strategy family should Finny start from?"
    answer: "Mean reversion"
    status: answered
  - id: directional_thesis_regime
    question: "What directional thesis or market regime should the strategy express?"
    answer: "Long-biased range-bound reversal"
    status: answered
  - id: entry_signal_idea
    question: "What entry signal idea should the strategy test?"
    answer: "Buy oversold reversals confirmed by RSI and Bollinger bands"
    status: answered
  - id: exit_invalidation_rules
    question: "What exit or invalidation rules matter?"
    answer: "Time stop, price stop, and thesis stop"
    status: answered
  - id: risk_tolerance_max_drawdown
    question: "What risk tolerance and maximum drawdown should the strategy respect?"
    answer: "Moderate risk, max 10% drawdown"
    status: answered
  - id: backtest_window_success_metric
    question: "What backtest window and success metric should Finny optimize for?"
    answer: "1y backtest, positive return with Sharpe > 1 and drawdown under 10%"
    status: answered
---

# REPLACE-ME

Rationale, sources, links, anything that helps a future reader or agent
understand *why* this algorithm exists. The frontmatter above is the
machine-read contract; this body is for humans and LLMs reading the folder
cold.
