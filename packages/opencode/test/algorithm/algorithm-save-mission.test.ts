import { describe, expect, test } from "bun:test"
import { Algorithm } from "../../src/algorithm"

function uniqueName() {
  return `mission-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

function mission(name: string, input?: { skippedInterval?: boolean }) {
  const skippedInterval = input?.skippedInterval === true
  return `---
schema_version: 3
name: ${name}
status: research
created: 2026-06-03
hypothesis: Test strategy mission.
scope:
  asset_class: crypto
  universe: [BTC]
  horizon: days
strategy:
  bar_interval: ${skippedInterval ? '""' : "1h"}
  type: custom-momentum
  direction: long
  entry_signal: "custom user breakout trigger"
  risk_profile: moderate
  max_drawdown_pct: "10"
  backtest_window: 1y
  success_metric: Sharpe above 1
exit_conditions: |
  - Time stop: 7 days
  - Price stop: -5%
questionnaire:
  - id: market_universe
    question: "Which market or universe should this strategy trade?"
    answer: "BTC custom universe"
    status: answered
  - id: timeframe_bar_interval
    question: "What trading timeframe and bar interval should this strategy use?"
    answer: ${skippedInterval ? '""' : '"1h bars"'}
    status: ${skippedInterval ? "skipped" : "answered"}
  - id: strategy_family
    question: "What strategy family should Finny start from?"
    answer: "Custom momentum"
    status: answered
  - id: directional_thesis_regime
    question: "What directional thesis or market regime should the strategy express?"
    answer: "Long breakout continuation"
    status: answered
  - id: entry_signal_idea
    question: "What entry signal idea should the strategy test?"
    answer: "custom user breakout trigger"
    status: answered
  - id: exit_invalidation_rules
    question: "What exit or invalidation rules matter?"
    answer: "7 day time stop and 5% price stop"
    status: answered
  - id: risk_tolerance_max_drawdown
    question: "What risk tolerance and maximum drawdown should the strategy respect?"
    answer: "Moderate risk, max 10% drawdown"
    status: answered
  - id: backtest_window_success_metric
    question: "What backtest window and success metric should Finny optimize for?"
    answer: "1y, Sharpe above 1"
    status: answered
---

# ${name}

${skippedInterval ? "(User skipped; ask when/if relevant)" : "All required questions answered."}
`
}

describe("Algorithm.save mission validation", () => {
  test("rejects new algorithm saves without a mission", async () => {
    await expect(
      Algorithm.save({
        name: uniqueName(),
        code: "class Strategy:\n    pass\n",
        saveMode: "new",
      }),
    ).rejects.toThrow(Algorithm.MissionValidationError)
  })

  test("rejects schema_version 2 missions for new algorithms", async () => {
    await expect(
      Algorithm.save({
        name: uniqueName(),
        code: "class Strategy:\n    pass\n",
        saveMode: "new",
        mission: "---\nschema_version: 2\nname: old-mission\n---\n",
      }),
    ).rejects.toThrow(Algorithm.MissionValidationError)
  })

  test("accepts v3 missions with custom answers and explicit skips", async () => {
    const name = uniqueName()
    const saved = await Algorithm.save({
      name,
      code: "class Strategy:\n    pass\n",
      saveMode: "new",
      mission: mission(name, { skippedInterval: true }),
      prefs: "# Preferences\n",
      decisions: "# Decisions\n",
    })

    expect(saved.name).toBe(name)
    expect(saved.version).toBe(1)

    await Algorithm.remove(saved.algorithmId)
  })
})
