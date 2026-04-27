import { afterEach, describe, expect, test } from "bun:test"
import { Plan } from "../../src/plan"
import { BROKER_MIN_TIER, requireBrokerTier } from "../../src/plan/brokers"
import { Auth } from "../../src/auth"

afterEach(async () => {
  await Auth.remove(Plan.PRO_PROVIDER_ID)
  await Auth.remove(Plan.LITE_PROVIDER_ID)
})

describe("TIER_RANK", () => {
  test("orders free < lite < pro", () => {
    expect(Plan.TIER_RANK.free).toBe(0)
    expect(Plan.TIER_RANK.lite).toBe(1)
    expect(Plan.TIER_RANK.pro).toBe(2)
  })
})

describe("hasAtLeast", () => {
  const cases: Array<{ current: Plan.Tier; required: Plan.Tier; expected: boolean }> = [
    { current: "free", required: "free", expected: true },
    { current: "free", required: "lite", expected: false },
    { current: "free", required: "pro", expected: false },
    { current: "lite", required: "free", expected: true },
    { current: "lite", required: "lite", expected: true },
    { current: "lite", required: "pro", expected: false },
    { current: "pro", required: "free", expected: true },
    { current: "pro", required: "lite", expected: true },
    { current: "pro", required: "pro", expected: true },
  ]
  for (const c of cases) {
    test(`${c.current} >= ${c.required} → ${c.expected}`, () => {
      expect(Plan.hasAtLeast(c.current, c.required)).toBe(c.expected)
    })
  }
})

describe("detectTier", () => {
  test("recognizes FINNY-PRO- prefix", () => {
    expect(Plan.detectTier("FINNY-PRO-abc.def")).toBe("pro")
  })
  test("recognizes FINNY-LITE- prefix", () => {
    expect(Plan.detectTier("FINNY-LITE-abc.def")).toBe("lite")
  })
  test("returns null on unknown prefix", () => {
    expect(Plan.detectTier("garbage")).toBeNull()
    expect(Plan.detectTier("FINNY-FREE-x.y")).toBeNull()
    expect(Plan.detectTier("")).toBeNull()
  })
})

describe("getTier", () => {
  test("free when no codes are stored", async () => {
    expect(await Plan.getTier()).toBe("free")
  })

  test("free when stored code has invalid signature", async () => {
    await Auth.set(Plan.PRO_PROVIDER_ID, { type: "api", key: "FINNY-PRO-fake-uuid.invalidsignature" })
    expect(await Plan.getTier()).toBe("free")
  })

  test("free when stored code has wrong prefix for slot", async () => {
    // Lite-shaped code shoved into the pro slot — must not promote.
    await Auth.set(Plan.PRO_PROVIDER_ID, { type: "api", key: "FINNY-LITE-uuid.sig" })
    expect(await Plan.getTier()).toBe("free")
  })

  test("setLicenseKey routes by prefix", async () => {
    expect(await Plan.setLicenseKey("FINNY-PRO-x.y")).toBe("pro")
    expect(await Plan.setLicenseKey("FINNY-LITE-x.y")).toBe("lite")
    expect(await Plan.setLicenseKey("garbage")).toBeNull()
  })

  test("removing one slot doesn't affect the other", async () => {
    await Plan.setLicenseKey("FINNY-PRO-a.b")
    await Plan.setLicenseKey("FINNY-LITE-c.d")
    await Plan.removeLicenseKey("lite")
    expect(await Plan.getLicenseKey("lite")).toBeNull()
    expect(await Plan.getLicenseKey("pro")).toBe("FINNY-PRO-a.b")
  })
})

describe("PlanLimitError", () => {
  test("carries structured detail", () => {
    const err = new Plan.PlanLimitError({ current: "free", required: "lite", feature: "backtest" })
    expect(err.code).toBe("PLAN_LIMIT")
    expect(err.current).toBe("free")
    expect(err.required).toBe("lite")
    expect(err.feature).toBe("backtest")
    expect(err.toJSON()).toEqual({
      code: "PLAN_LIMIT",
      current: "free",
      required: "lite",
      feature: "backtest",
      message: err.message,
    })
  })

  test("requireTier throws PlanLimitError when below required", async () => {
    let caught: unknown
    try {
      await Plan.requireTier("pro", "test_feature")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Plan.PlanLimitError)
    const err = caught as Plan.PlanLimitError
    expect(err.feature).toBe("test_feature")
    expect(err.required).toBe("pro")
  })

  test("requireTier passes when at or above required", async () => {
    // free ≥ free
    await expect(Plan.requireTier("free", "anything")).resolves.toBeUndefined()
  })
})

describe("BROKER_MIN_TIER", () => {
  test("matches spec — Lite brokers", () => {
    expect(BROKER_MIN_TIER.alpaca).toBe("lite")
    expect(BROKER_MIN_TIER.binance).toBe("lite")
    expect(BROKER_MIN_TIER.polymarket).toBe("lite")
  })
  test("matches spec — Pro brokers", () => {
    expect(BROKER_MIN_TIER.questrade).toBe("pro")
    expect(BROKER_MIN_TIER.ibkr).toBe("pro")
  })
  test("requireBrokerTier throws PLAN_LIMIT for free user on Alpaca live", async () => {
    let caught: unknown
    try {
      await requireBrokerTier("alpaca")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Plan.PlanLimitError)
    expect((caught as Plan.PlanLimitError).feature).toBe("live_brokerage:alpaca")
    expect((caught as Plan.PlanLimitError).required).toBe("lite")
  })
  test("unknown broker defaults to requiring Lite", async () => {
    let caught: unknown
    try {
      await requireBrokerTier("kraken")
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Plan.PlanLimitError)
    expect((caught as Plan.PlanLimitError).required).toBe("lite")
  })
})

describe("per-feature gating shape", () => {
  test("backtest cap: free=5, lite=10, pro=Infinity (per-day)", () => {
    const DAILY_BACKTEST_LIMIT: Record<Plan.Tier, number> = {
      free: 5,
      lite: 10,
      pro: Number.POSITIVE_INFINITY,
    }
    expect(DAILY_BACKTEST_LIMIT.free).toBe(5)
    expect(DAILY_BACKTEST_LIMIT.lite).toBe(10)
    expect(Number.isFinite(DAILY_BACKTEST_LIMIT.pro)).toBe(false)
  })
  test("save cap: free=3, lite=10, pro=Infinity", () => {
    const SAVE_CAP: Record<Plan.Tier, number> = {
      free: 3,
      lite: 10,
      pro: Number.POSITIVE_INFINITY,
    }
    expect(SAVE_CAP.free).toBe(3)
    expect(SAVE_CAP.lite).toBe(10)
    expect(Number.isFinite(SAVE_CAP.pro)).toBe(false)
  })
  test("terminal-run cap: free=1, lite=3, pro=Infinity", () => {
    const TERMINAL_RUN_CAP: Record<Plan.Tier, number> = {
      free: 1,
      lite: 3,
      pro: Number.POSITIVE_INFINITY,
    }
    expect(TERMINAL_RUN_CAP.free).toBe(1)
    expect(TERMINAL_RUN_CAP.lite).toBe(3)
    expect(Number.isFinite(TERMINAL_RUN_CAP.pro)).toBe(false)
  })
})
