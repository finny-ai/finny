import { describe, expect, test } from "bun:test"
import { promptFromParams } from "../../src/tool/workspace-prepare"
import { parseRequestFacts } from "../../src/agent/request-identity"

describe("workspace prepare request context", () => {
  test("puts structured dates before summary dates", () => {
    const prompt = promptFromParams(
      {
        requestSummary: "Earlier context mentions 2023-01-01 and 2023-06-01.",
        startDate: "2024-07-10",
        endDate: "2026-07-10",
      },
      "",
    )
    expect(prompt.startsWith("date window 2024-07-10 to 2026-07-10")).toBe(true)
  })

  test("keeps structured SPY identity ahead of SMA(200) prose", () => {
    const prompt = promptFromParams(
      {
        requestSummary: "Build a named SMA(200) strategy; older notes called this a 200d setup.",
        algorithmName: "spy-sma-200",
        symbol: "SPY",
        assetClass: "equity",
        interval: "1d",
        startDate: "2018-01-01",
        endDate: "2025-12-31",
      },
      "",
    )
    expect(parseRequestFacts(prompt)).toMatchObject({
      requested_symbol: "SPY",
      requested_interval: "1d",
      requested_asset_class: "equity",
    })
    expect(prompt.startsWith("algorithm spy-sma-200; symbol SPY; asset class equity; interval 1d")).toBe(true)
    expect(prompt.indexOf("2018-01-01")).toBeLessThan(prompt.indexOf("200d"))
  })
})
