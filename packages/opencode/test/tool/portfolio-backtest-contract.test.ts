import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

describe("portfolio backtest execution contract", () => {
  test("does not future-backfill FX and labels analytics-only eligibility", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "../../src/tool/portfolio-backtest.ts"), "utf8")
    expect(source).toContain("s.reindex(px.index).ffill()")
    expect(source).not.toContain("s.reindex(px.index).ffill().bfill()")
    expect(source).toContain('"analytics_only": True')
    expect(source).toContain('"production_eligible": False')
    expect(source).toContain("does not yet apply engine_v2 execution profiles/costs")
  })
})
