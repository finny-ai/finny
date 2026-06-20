import { describe, expect, test } from "bun:test"
import { Templates } from "../../src/algorithm/templates"
import { Validate } from "../../src/algorithm/validate"

describe("algorithm templates", () => {
  test("momentum scaffold is validator-clean", async () => {
    const result = await Validate.run(Templates.get("momentum"), { skipSmokeTest: true })
    expect(result.valid).toBe(true)
    expect(result.errors.map((err) => err.code)).not.toContain("DIVISION_NO_ZERO_CHECK")
  })

  test("validator accepts early denominator guards in helper methods", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.rsi_period = int((params or {}).get("rsi_period", 14))
        self.closes = [1.0, 2.0, 3.0]

    def _avg_close(self):
        if self.rsi_period <= 0:
            return 0.0
        total = 0.0
        for close in self.closes:
            total += close
        return total / self.rsi_period

    def on_bar(self, symbol, bar):
        return
`,
      { skipSmokeTest: true },
    )
    expect(result.warnings.map((err) => err.code)).not.toContain("DIVISION_NO_ZERO_CHECK")
  })

  test("validator accepts integer period guards below one", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.period = int((params or {}).get("period", 14))
        self.gains = [1.0, 2.0, 3.0]

    def on_bar(self, symbol, bar):
        if self.period < 1:
            return
        avg_gain = sum(self.gains) / self.period
        return
`,
      { skipSmokeTest: true },
    )
    expect(result.warnings.map((err) => err.code)).not.toContain("DIVISION_NO_ZERO_CHECK")
  })

  test("validator still warns when denominator is unguarded", async () => {
    const result = await Validate.run(
      `
class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        self.rsi_period = int((params or {}).get("rsi_period", 14))
        self.closes = [1.0, 2.0, 3.0]

    def _avg_close(self):
        total = 0.0
        for close in self.closes:
            total += close
        return total / self.rsi_period

    def on_bar(self, symbol, bar):
        return
`,
      { skipSmokeTest: true },
    )
    expect(result.warnings.map((err) => err.code)).toContain("DIVISION_NO_ZERO_CHECK")
  })
})
