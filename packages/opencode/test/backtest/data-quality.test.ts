import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

const root = path.resolve(import.meta.dir, "../..")

describe("engine_v2 data quality source contract", () => {
  test("quality module exposes outlier diagnostics and isolated repair", async () => {
    const source = await fs.readFile(path.join(root, "engine_v2/data/quality.py"), "utf8")

    expect(source).toContain("class OutlierDetail")
    expect(source).toContain("timestamp: str")
    expect(source).toContain("previous_close: float")
    expect(source).toContain("current_close: float")
    expect(source).toContain("z_score: float")
    expect(source).toContain("def repair_isolated_outliers")
    expect(source).toContain("refuses to repair clusters")
    expect(source).toContain("repair_applied")
    expect(source).toContain("repaired_outliers")
  })

  test("strict engine has explicit repair_outliers mode and keeps strict default", async () => {
    const source = await fs.readFile(path.join(root, "engine_v2/cli.py"), "utf8")

    expect(source).toContain('choices=["strict", "repair_outliers"]')
    expect(source).toContain('default="strict"')
    expect(source).toContain('__FINNY_OUTLIER__')
    expect(source).toContain("Data quality failed before resample")
    expect(source).toContain("Data quality failed after resample")
    expect(source).toContain("all(\"severe outlier\" in reason")
    expect(source).toContain("duplicate_ts_count == 0")
    expect(source).toContain("ohlc_violations == 0")
  })
})
