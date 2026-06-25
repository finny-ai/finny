import { describe, expect, test } from "bun:test"
import { LiveRunner } from "../../src/live/runner"

describe("LiveRunner eligibility gate", () => {
  test("allows paper and testnet from a completed backtest without robustness", () => {
    expect(LiveRunner.canStartForMode("backtested", "paper")).toBe(true)
    expect(LiveRunner.canStartForMode("backtested", "testnet")).toBe(true)
  })

  test("requires robustness for live-money runs", () => {
    expect(LiveRunner.canStartForMode("backtested", "live")).toBe(false)
    expect(LiveRunner.canStartForMode("robustness_passed", "live")).toBe(false)
    expect(LiveRunner.canStartForMode("paper_eligible", "live")).toBe(true)
    expect(LiveRunner.canStartForMode("live_eligible", "live")).toBe(true)
  })

  test("blocks paper when no completed backtest exists", () => {
    expect(LiveRunner.canStartForMode(null, "paper")).toBe(false)
    expect(LiveRunner.canStartForMode("validated", "paper")).toBe(false)
    expect(LiveRunner.canStartForMode("prototype", "paper")).toBe(false)
  })

  test("only terminal live runs can be removed", () => {
    expect(LiveRunner.canRemoveStatus("starting")).toBe(false)
    expect(LiveRunner.canRemoveStatus("running")).toBe(false)
    expect(LiveRunner.canRemoveStatus("stopped")).toBe(true)
    expect(LiveRunner.canRemoveStatus("error")).toBe(true)
  })
})
