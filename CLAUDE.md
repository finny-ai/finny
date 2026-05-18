# Finny — Agent Instructions

## Commits and PRs

- **Do not add `Co-Authored-By: Claude ... <noreply@anthropic.com>` (or any
  Claude/Anthropic co-author trailer) to commit messages.**
- **Do not add "🤖 Generated with [Claude Code]" footers to PR descriptions.**

Commits and PRs should look like normal human-authored work. End the message
at the substantive body — no AI attribution.

This applies to every Claude/agent session in this repo and overrides the
default commit/PR templates.

## Backtest & strategy workflow

1. **Read the shape table first.** Before writing or editing any strategy,
   read `algos/_template/README.md` § "Strategy API & runner shapes" to
   confirm the correct constructor, method signature, and broker API.

2. **No success claim without a run.** Only claim a strategy is backtested
   when `finny_backtest_run` returned `ok: true` with actual metrics.
   Never write "Status: Backtested" or "shows edge" without tool output.

3. **No live-deployment recommendation without metrics.** Cite Sharpe ratio
   and max drawdown from actual backtest output before recommending any
   strategy for paper or live trading.

4. **Stop after two backtest failures.** If `finny_backtest_run` fails twice
   consecutively, stop and re-read the loader contract and strategy template.
   Do not keep reshaping the strategy class from error messages alone.

5. **Lookahead rule.** Only `bar["open"]` is decision-time-safe on the
   current bar. Compute indicators from historical closes (previous bars),
   not the current bar's close. RSI, SMA, and Bollinger bands must exclude
   the current bar before making trade decisions.

6. **Cite numbers to tool calls.** Market claims must reference tool output
   (e.g., "USO +3.7% per `finny_get_history`"). No fabricated narratives.

7. **Validator warnings must clear.** If `finny_algorithm_validate` returns
   warnings, fix the root cause — do not paper over them.

8. **Respect tool enums.** `asset_class` is `equity` | `crypto`. Cron
   day-of-week is numeric (0–6), not `MON-FRI`.
