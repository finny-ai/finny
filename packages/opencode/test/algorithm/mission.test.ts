import { describe, expect, test } from "bun:test"
import { Mission } from "../../src/algorithm/mission"
import { bindMissionRiskContract, contractRejectionBlock, missionRejectionMessage } from "../../src/tool/algorithm-save"

const questionnaire = (overrides: Record<string, Partial<{ answer: string; status: string }>> = {}) =>
  Mission.CORE8_IDS.map((id) => {
    const o = overrides[id] ?? {}
    return [
      `  - id: ${id}`,
      `    question: "Question for ${id}?"`,
      `    answer: "${o.answer ?? "an answer"}"`,
      `    status: ${o.status ?? "answered"}`,
    ].join("\n")
  }).join("\n")

const validMission = (frontmatterOverrides = "") =>
  `---
schema_version: 3
name: btc-mean-reversion
status: research
created: 2026-06-10
hypothesis: Mean reversion after capitulation produces positive risk-adjusted returns.
scope:
  asset_class: crypto
  universe: [BTC]
  horizon: weeks
strategy:
  bar_interval: 1d
  type: mean-reversion
  direction: both
  entry_signal: RSI oversold with volatility filter
  risk_profile: moderate
  max_drawdown_pct: "15"
  backtest_window: 6mo
  success_metric: Sharpe above 0.8 with max drawdown under 15%
exit_conditions: |
  - Exit on RSI normalization
${frontmatterOverrides}questionnaire:
${questionnaire()}
---

# btc-mean-reversion

Workspace body.

## User Preferences

- Capital: $10,000
`

const validMissionV4 = () =>
  validMission()
    .replace("schema_version: 3", "schema_version: 4")
    .replace(
      "exit_conditions:",
      `risk_contract:
  sizing_stop_distance_pct: 2
  protective_stop:
    mode: strategy_next_open
  drawdown:
    mode: halt_and_flatten_next_open
    limit_pct: 15
  max_positions: 1
exit_conditions:`,
    )

describe("Mission.validate", () => {
  test("accepts a complete v3 mission", () => {
    expect(Mission.validate(validMission())).toEqual([])
  })

  test("requires v4 risk fields for new saves while retaining v3 read compatibility", () => {
    expect(Mission.validate(validMissionV4())).toEqual([])
    expect(Mission.validateForNewSave(validMissionV4())).toEqual([])
    expect(Mission.validateForNewSave(validMission())).toContain(
      "schema_version: new saves require schema_version 4 with a complete risk_contract",
    )
    expect(Mission.riskContract(validMissionV4())).toEqual({
      sizing_stop_distance_pct: 2,
      protective_stop: { mode: "strategy_next_open" },
      drawdown: { mode: "halt_and_flatten_next_open", limit_pct: 15 },
      max_positions: 1,
    })
  })

  test("rejects invalid v4 risk modes and bounds", () => {
    const issues = Mission.validateForNewSave(
      validMissionV4()
        .replace("mode: strategy_next_open", "mode: magic_stop")
        .replace("limit_pct: 15", "limit_pct: 0"),
    )
    expect(issues.some((issue) => issue.startsWith("risk_contract.protective_stop.mode:"))).toBe(true)
    expect(issues.some((issue) => issue.startsWith("risk_contract.drawdown.limit_pct:"))).toBe(true)
  })

  test("binds the validated risk contract into executable config", () => {
    const config = bindMissionRiskContract(JSON.stringify({ symbol: "SPY", params: { fast: 10 } }), validMissionV4())
    expect(JSON.parse(config!)).toEqual({
      symbol: "SPY",
      params: { fast: 10 },
      risk_contract: {
        sizing_stop_distance_pct: 2,
        protective_stop: { mode: "strategy_next_open" },
        drawdown: { mode: "halt_and_flatten_next_open", limit_pct: 15 },
        max_positions: 1,
      },
    })
  })

  test("rejects a missing mission", () => {
    const issues = Mission.validate(undefined)
    expect(issues.length).toBe(1)
    expect(issues[0]).toContain("mission is missing")
  })

  test("rejects prose without frontmatter", () => {
    const issues = Mission.validate("# My Strategy\n\nJust prose.")
    expect(issues.some((i) => i.includes("missing YAML frontmatter"))).toBe(true)
  })

  test("rejects invalid status and horizon enums (the session failure)", () => {
    const mission = validMission()
      .replace("status: research", "status: draft")
      .replace("horizon: weeks", "horizon: swing")
    const issues = Mission.validate(mission)
    expect(issues.some((i) => i.startsWith("status:"))).toBe(true)
    expect(issues.some((i) => i.startsWith("scope.horizon:"))).toBe(true)
  })

  test("rejects a missing Core 8 questionnaire item", () => {
    const mission = validMission().replace(/ {2}- id: strategy_family\n(?: {4}.*\n){3}/, "")
    const issues = Mission.validate(mission)
    expect(issues.some((i) => i.includes("missing Core 8 item `strategy_family`"))).toBe(true)
  })

  test("rejects answered items with an empty answer", () => {
    const mission = `---
schema_version: 3
name: btc-mean-reversion
status: research
created: 2026-06-10
hypothesis: H.
scope:
  asset_class: crypto
  universe: [BTC]
  horizon: weeks
strategy:
  bar_interval: 1d
  type: mean-reversion
  direction: both
  entry_signal: RSI
  risk_profile: moderate
  max_drawdown_pct: "15"
  backtest_window: 6mo
  success_metric: Sharpe above 0.8
exit_conditions: Exit on RSI normalization.
questionnaire:
${questionnaire({ strategy_family: { answer: "" } })}
---
body`
    const issues = Mission.validate(mission)
    expect(issues.some((i) => i.includes("answered items need a non-empty answer"))).toBe(true)
  })

  test("accepts skipped items with empty answers", () => {
    const mission = validMission().replace(
      /- id: risk_tolerance_max_drawdown\n( {4})question: "([^"]*)"\n {4}answer: "[^"]*"\n {4}status: answered/,
      '- id: risk_tolerance_max_drawdown\n$1question: "$2"\n    answer: ""\n    status: skipped',
    )
    expect(Mission.validate(mission)).toEqual([])
  })
})

describe("contractRejectionBlock", () => {
  test("reports mission AND config issues in one combined response", () => {
    const block = contractRejectionBlock(
      ["status: Invalid option"],
      ["missing required config field(s): symbol, interval"],
    )
    expect(block).toBeDefined()
    expect(block!.output).toContain("Config issues:")
    expect(block!.output).toContain("missing required config field(s): symbol, interval")
    expect(block!.output).toContain("status: Invalid option")
    expect(block!.output).toContain("schema_version: 4")
    expect(block!.metadata).toMatchObject({ blocked: true, missionInvalid: true, configRequired: true })
  })

  test("returns undefined when there are no issues", () => {
    expect(contractRejectionBlock([], [])).toBeUndefined()
  })

  test("config-only rejection skips the mission template", () => {
    const block = contractRejectionBlock([], ["symbol must be one tradable symbol"])
    expect(block!.output).toContain("Config issues:")
    expect(block!.output).not.toContain("schema_version: 4")
    expect(block!.metadata).toMatchObject({ missionInvalid: false, configRequired: true })
  })
})

describe("missionRejectionMessage", () => {
  test("leads with the issues and includes the full v4 template", () => {
    const message = missionRejectionMessage(["status: Invalid option"])
    expect(message).toContain("  - status: Invalid option")
    expect(message).toContain("schema_version: 4")
    expect(message).toContain("risk_contract:")
    expect(message).toContain("hypothesis: |")
    expect(message).toContain("YAML safety")
    expect(message).toContain("status: research | backtested | paper | live | retired")
    for (const id of Mission.CORE8_IDS) {
      expect(message).toContain(`- id: ${id}`)
    }
  })
})
