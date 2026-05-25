import { describe, expect, test } from "bun:test"
import { Validate } from "../../src/algorithm/validate"

function mkResult(warnings: Array<{ code: string; message: string }>): Validate.Result {
  return {
    valid: true,
    errors: [],
    warnings: warnings.map(w => ({ code: w.code as any, severity: "warning", message: w.message })),
  }
}

function mkErrorResult(errors: Array<{ code: string; message: string }>): Validate.Result {
  return {
    valid: false,
    errors: errors.map(e => ({ code: e.code as any, severity: "error", message: e.message })),
    warnings: [],
  }
}

describe("Validate.hasRiskWarnings", () => {
  test("returns true when LOOKAHEAD_BIAS_FLOW is present", () => {
    const r = mkResult([{ code: "LOOKAHEAD_BIAS_FLOW", message: "uses bar.close before broker.buy" }])
    expect(Validate.hasRiskWarnings(r)).toBe(true)
  })

  test("returns true when LEVERAGE_VIOLATION is present", () => {
    const r = mkResult([{ code: "LEVERAGE_VIOLATION", message: "size exceeds 1x cash" }])
    expect(Validate.hasRiskWarnings(r)).toBe(true)
  })

  test("returns false when only non-risk warnings", () => {
    const r = mkResult([{ code: "UNBOUNDED_LIST", message: "append without deque" }])
    expect(Validate.hasRiskWarnings(r)).toBe(false)
  })

  test("returns false when no warnings", () => {
    expect(Validate.hasRiskWarnings(mkResult([]))).toBe(false)
  })
})

describe("Validate.formatRiskBanner", () => {
  test("returns empty string when no risk warnings", () => {
    expect(Validate.formatRiskBanner(mkResult([]))).toBe("")
    expect(Validate.formatRiskBanner(mkResult([{ code: "UNBOUNDED_LIST", message: "x" }]))).toBe("")
  })

  test("prefixes [!] RISK WARNINGS and lists each code", () => {
    const r = mkResult([
      { code: "LOOKAHEAD_BIAS_FLOW", message: "reads bar.close before deciding" },
      { code: "POSITION_SIZE_UNCAPPED", message: "buys with all cash" },
    ])
    const banner = Validate.formatRiskBanner(r)
    expect(banner).toContain("[!] RISK DIAGNOSTICS (2)")
    expect(banner).toContain("LOOKAHEAD_BIAS_FLOW")
    expect(banner).toContain("POSITION_SIZE_UNCAPPED")
    expect(banner).toContain("reads bar.close before deciding")
  })

  test("includes hard risk errors after strict gating", () => {
    const banner = Validate.formatRiskBanner(mkErrorResult([
      { code: "SAME_BAR_EXECUTION_BIAS", message: "uses same bar close" },
    ]))
    expect(banner).toContain("RISK DIAGNOSTICS")
    expect(banner).toContain("SAME_BAR_EXECUTION_BIAS")
  })
})

describe("Validate.format() integration with risk banner", () => {
  test("risk banner appears before other output", () => {
    const r = mkResult([
      { code: "LOOKAHEAD_BIAS_FLOW", message: "lookahead" },
      { code: "UNBOUNDED_LIST", message: "memory leak" },
    ])
    const out = Validate.format(r)
    const riskIdx = out.indexOf("RISK DIAGNOSTICS")
    const otherIdx = out.indexOf("UNBOUNDED_LIST")
    expect(riskIdx).toBeGreaterThanOrEqual(0)
    // Non-risk warnings appear in a separate block AFTER the banner.
    expect(otherIdx).toBeGreaterThan(riskIdx)
  })
})

describe("Validate strict Shape C gates", () => {
  test("accepts strict Shape C with prev_close decision data", async () => {
    const code = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.done = False
    def on_bar(self, symbol, bar):
        if bar["prev_close"] is not None and not self.done and bar["open"] > bar["prev_close"]:
            self.broker.buy(symbol, notional=self.broker.cash() * 0.5)
            self.done = True
`
    const result = await Validate.run(code, { config: { symbol: "TEST" }, skipSmokeTest: true })
    expect(result.valid).toBe(true)
  })

  test("rejects legacy on_tick in strict mode", async () => {
    const code = `class Strategy:
    def __init__(self):
        pass
    def on_tick(self, bar):
        return "BUY"
`
    const result = await Validate.run(code, { config: { symbol: "TEST" }, skipSmokeTest: true })
    expect(result.valid).toBe(false)
    expect(result.errors.map(e => e.code)).toContain("STRICT_SHAPE_REQUIRED")
  })

  test("rejects current-bar close access", async () => {
    const code = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        if bar["close"] > bar["open"]:
            self.broker.buy(symbol, qty=1)
`
    const result = await Validate.run(code, { config: { symbol: "TEST" }, skipSmokeTest: true })
    expect(result.valid).toBe(false)
    expect(result.errors.map(e => e.code)).toContain("LOOKAHEAD_BIAS_FLOW")
  })

  test("rejects private broker reflection", async () => {
    const code = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        x = getattr(self.broker, "_broker")
        self.broker.buy(symbol, qty=1)
`
    const result = await Validate.run(code, { config: { symbol: "TEST" }, skipSmokeTest: true })
    expect(result.valid).toBe(false)
    expect(result.errors.map(e => e.code)).toContain("PRIVATE_BROKER_ACCESS")
  })

  test("rejects aliased private broker mutation", async () => {
    const code = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        b = self.broker
        b._cash = 999999999
        b.buy(symbol, qty=1)
`
    const result = await Validate.run(code, { config: { symbol: "TEST" }, skipSmokeTest: true })
    expect(result.valid).toBe(false)
    expect(result.errors.map(e => e.code)).toContain("PRIVATE_BROKER_ACCESS")
  })

  test("rejects options configs from product validation", async () => {
    const code = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
    def on_bar(self, symbol, bar):
        pass
`
    const result = await Validate.run(code, {
      config: { symbol: "AAPL240621C00100000", asset_class: "option" },
      skipSmokeTest: true,
    })
    expect(result.valid).toBe(false)
    expect(result.errors.map(e => e.code)).toContain("UNSUPPORTED_STRATEGY_CONTRACT")
  })

  test("rejects delayed oversized leverage after the old 200-bar smoke window", async () => {
    const code = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.last_close = None
        self.bar_count = 0
        self.test_traded = False
        self.oversized_bought = False
    def on_bar(self, symbol, bar):
        close_px = bar["prev_close"]
        open_px = bar["open"]
        if close_px is None:
            return
        self.bar_count += 1
        if self.last_close is not None and close_px == self.last_close:
            self.last_close = close_px
            return
        pos = self.broker.position(symbol)
        if not self.test_traded and self.bar_count >= 10:
            self.broker.buy(symbol, qty=(self.broker.equity() * 0.01) / open_px)
            self.test_traded = True
        if self.test_traded and pos > 0 and self.bar_count >= 12:
            self.broker.sell(symbol, qty=pos)
        if not self.oversized_bought and self.bar_count >= 250:
            qty = (self.broker.equity() * 15) / open_px
            self.broker.buy(symbol, qty=qty)
            self.oversized_bought = True
        self.last_close = close_px
`
    const result = await Validate.run(code, { config: { symbol: "BTC/USD" } })
    expect(result.valid).toBe(false)
    expect(result.errors.map(e => e.code)).toContain("LEVERAGE_VIOLATION")
  })

  test("accepts small valid perp-style sizing through smoke validation", async () => {
    const code = `class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.last_close = None
        self.traded = False
    def on_bar(self, symbol, bar):
        close_px = bar["prev_close"]
        open_px = bar["open"]
        if close_px is None:
            return
        if self.last_close is None:
            self.last_close = close_px
            return
        if self.last_close is not None and close_px == self.last_close:
            self.last_close = close_px
            return
        if not self.traded and self.broker.position(symbol) == 0:
            self.broker.buy(symbol, qty=1)
            self.traded = True
        self.last_close = close_px
`
    const result = await Validate.run(code, { config: { symbol: "BTC/USD" } })
    expect(result.valid).toBe(true)
  })
})
