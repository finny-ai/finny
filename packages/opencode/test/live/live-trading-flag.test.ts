import { describe, expect, test } from "bun:test"
import {
  brokerModeChoices,
  liveTradingDisabledReason,
  liveTradingEnabled,
} from "../../src/live/brokers/live-trading"
import { ibkrSpec } from "../../src/live/brokers/ibkr"

describe("FINNY_LIVE_TRADING", () => {
  test("defaults to enabled", () => {
    expect(liveTradingEnabled({} as NodeJS.ProcessEnv)).toBe(true)
    expect(brokerModeChoices(["paper", "live"], {} as NodeJS.ProcessEnv)).toEqual(["paper", "live"])
  })

  test("hides live mode when disabled", () => {
    for (const value of ["false", "FALSE", "0", "no", "off"]) {
      const env = { FINNY_LIVE_TRADING: value } as NodeJS.ProcessEnv
      expect(liveTradingEnabled(env)).toBe(false)
      expect(brokerModeChoices(["paper", "live"], env)).toEqual(["paper"])
      expect(brokerModeChoices(["testnet", "live"], env)).toEqual(["testnet"])
    }
  })

  test("keeps live mode for any non-disabled value", () => {
    const env = { FINNY_LIVE_TRADING: "true" } as NodeJS.ProcessEnv
    expect(liveTradingEnabled(env)).toBe(true)
    expect(brokerModeChoices(["paper", "live"], env)).toEqual(["paper", "live"])
  })

  test("blocks live mode and custom endpoints when disabled", () => {
    const env = { FINNY_LIVE_TRADING: "false" } as NodeJS.ProcessEnv

    expect(
      liveTradingDisabledReason(
        ibkrSpec,
        { keyId: "DU123", secret: "", endpoint: "127.0.0.1:7497", mode: "paper" },
        env,
      ),
    ).toBeNull()

    expect(
      liveTradingDisabledReason(
        ibkrSpec,
        { keyId: "DU123", secret: "", endpoint: "127.0.0.1:4001", mode: "paper" },
        env,
      ),
    ).toContain("custom endpoints are disabled")

    expect(
      liveTradingDisabledReason(
        ibkrSpec,
        { keyId: "U123", secret: "", endpoint: "127.0.0.1:7496", mode: "live" },
        env,
      ),
    ).toContain("live trading is disabled")
  })
})
