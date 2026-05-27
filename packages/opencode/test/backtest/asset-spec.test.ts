import { describe, expect, test } from "bun:test"
import { normalizeAssetClass, resolveAssetSpec } from "../../src/backtest/asset-spec"

describe("AssetSpec registry", () => {
  test("maps legacy crypto asset_class to crypto_spot", () => {
    expect(normalizeAssetClass("crypto", "BTC-USD")).toBe("crypto_spot")
    const spec = resolveAssetSpec({ symbol: "BTC-USD", asset_class: "crypto" }, "BTC-USD")
    expect(spec.assetClass).toBe("crypto_spot")
    expect(spec.productionEligible).toBe(true)
  })

  test("requires explicit derivative asset class", () => {
    const spec = resolveAssetSpec({ symbol: "ES=F", asset_class: "future" }, "ES=F")
    expect(spec.assetClass).toBe("future")
    expect(spec.multiplier).toBeGreaterThan(1)
  })

  test("infers supported futures roots and applies per-contract specs", () => {
    expect(normalizeAssetClass(undefined, "ES")).toBe("future")
    const es = resolveAssetSpec({ symbol: "ES" }, "ES")
    const nq = resolveAssetSpec({ symbol: "NQ" }, "NQ")
    const cl = resolveAssetSpec({ symbol: "CL" }, "CL")
    expect(es.assetClass).toBe("future")
    expect(es.multiplier).toBe(50)
    expect(es.initialMarginPct).toBe(0.05)
    expect(es.maintenanceMarginPct).toBe(0.04)
    expect(es.commissionPerContract).toBe(2.25)
    expect(nq.multiplier).toBe(20)
    expect(cl.multiplier).toBe(1000)
    expect(cl.tickSize).toBe(0.01)
  })

  test("represents options but marks them ineligible", () => {
    const spec = resolveAssetSpec({ symbol: "AAPL240621C00100000", asset_class: "option" }, "AAPL240621C00100000")
    expect(spec.assetClass).toBe("option")
    expect(spec.productionEligible).toBe(false)
    expect(spec.blockingReason).toContain("Options require")
  })

  test("crypto perps require funding and maintenance margin for production eligibility", () => {
    const unsafe = resolveAssetSpec({ symbol: "BTC-USD", asset_class: "crypto_perp" }, "BTC-USD")
    expect(unsafe.productionEligible).toBe(false)
    const eligible = resolveAssetSpec({
      symbol: "BTC-USD",
      asset_class: "crypto_perp",
      execution: { funding_rate_bps: 1, maintenance_margin_pct: 0.05 },
    }, "BTC-USD")
    expect(eligible.productionEligible).toBe(true)
  })
})
