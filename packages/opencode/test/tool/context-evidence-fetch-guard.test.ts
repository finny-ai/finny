import { describe, expect, test } from "bun:test"
import fs from "node:fs"

const guardedTools = [
  ["price-history.ts", "Historical market-data fetch"],
  ["quote.ts", "Live market-data fetch"],
  ["webfetch.ts", "Direct web evidence fetch"],
  ["websearch.ts", "Direct web evidence search"],
] as const

describe("pending strategy-context evidence ownership", () => {
  for (const [filename, action] of guardedTools) {
    test(`${filename} blocks a duplicate parent fetch before external work`, () => {
      const source = fs.readFileSync(new URL(`../../src/tool/${filename}`, import.meta.url), "utf8")
      const guard = source.indexOf("StrategyContext.duplicateFetchBlock")
      expect(guard).toBeGreaterThanOrEqual(0)
      expect(source.slice(guard, guard + 500)).toContain(action)

      const externalBoundary = Math.min(
        ...[source.indexOf("ctx.ask", guard), source.indexOf("resolveSessionPythonEnv", guard), source.indexOf("callProvider(", guard)]
          .filter((index) => index >= 0),
      )
      expect(externalBoundary).toBeGreaterThan(guard)
    })
  }
})
