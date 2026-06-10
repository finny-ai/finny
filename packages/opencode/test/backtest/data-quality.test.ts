import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Process } from "../../src/util/process"

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
    expect(source).toContain("def is_intraday_interval")
    expect(source).toContain("def _continuous_return_mask")
    expect(source).toContain("overnight/weekend gaps")
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
    expect(source).toContain("def _apply_regular_hours_filter")
    expect(source).toContain("extended_hours")
    expect(source).toContain("America/New_York")
    expect(source).toContain("No bars after regular-hours filter")
  })

  test("equity intraday outliers ignore session gaps but keep continuous bad bars", async () => {
    const pandas = await Process.run(["python3", "-c", "import pandas"], { nothrow: true })
    if (pandas.code !== 0) return

    const script = `
import json
import pandas as pd
from engine_v2.data import quality as DQ

def rows(include_intraday_spike):
    out = []
    px = 100.0
    t = pd.Timestamp("2026-04-01T13:30:00Z")
    for i in range(20):
        px *= 1.001 if i % 2 == 0 else 0.999
        out.append({"timestamp": t + pd.Timedelta(minutes=15 * i), "open": px, "high": px, "low": px, "close": px, "volume": 1000})
    t = pd.Timestamp("2026-04-02T13:30:00Z")
    px *= 1.30
    for i in range(90):
        if include_intraday_spike and i == 45:
            px *= 1.20
        else:
            px *= 1.001 if i % 2 == 0 else 0.999
        out.append({"timestamp": t + pd.Timedelta(minutes=15 * i), "open": px, "high": px, "low": px, "close": px, "volume": 1000})
    return pd.DataFrame(out)

gap_only = DQ.analyze(rows(False), "15min", "equity", provider="test")
continuous_spike = DQ.analyze(rows(True), "15min", "equity", provider="test")
print(json.dumps({"gap_only": gap_only.outlier_bars, "continuous_spike": continuous_spike.outlier_bars}))
`
    const out = await Process.run(["python3", "-c", script], {
      env: { PYTHONPATH: root },
    })
    const result = JSON.parse(out.stdout.toString())
    expect(result.gap_only).toBe(0)
    expect(result.continuous_spike).toBeGreaterThan(0)
  })
})
