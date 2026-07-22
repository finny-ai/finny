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
    expect(source).toContain("def _minimum_outlier_log_return")
    expect(source).toContain("overnight/weekend gaps")
    expect(source).toContain("statistically extreme and large enough")
    expect(source).toContain("isolated_tolerance")
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

  test("NYSE hourly bars retain their exchange-open anchor and include the closing bucket", async () => {
    const source = await fs.readFile(path.join(root, "engine_v2/cli.py"), "utf8")
    const calendars = await fs.readFile(path.join(root, "engine_v2/data/calendars.py"), "utf8")

    expect(source).toContain("positive_deltas.min() >= target_step")
    expect(source).toContain("breaking exact calendar reconciliation")
    expect(calendars).toContain('pd.date_range(start, end, freq=step, inclusive="left")')

    const workspacePython = process.env.FINNY_TEST_PYTHON
    const python = workspacePython
      ? await Process.run([workspacePython, "-c", "import pandas"], { nothrow: true })
      : await Process.run(["python3", "-c", "import pandas"], { nothrow: true })
    if (python.code !== 0) return

    const script = `
import json
import pandas as pd
from engine_v2.cli import _resample
from engine_v2.data.calendars import ExpectedTimestampRequest, expected_timestamps
from engine_v2.data.quality import analyze, blocking_reasons

timestamps = pd.to_datetime([
    "2026-07-20T13:30:00Z", "2026-07-20T14:30:00Z", "2026-07-20T15:30:00Z",
    "2026-07-20T16:30:00Z", "2026-07-20T17:30:00Z", "2026-07-20T18:30:00Z",
    "2026-07-20T19:30:00Z",
], utc=True)
df = pd.DataFrame({
    "timestamp": timestamps,
    "open": range(7), "high": range(7), "low": range(7), "close": range(7), "volume": [1] * 7,
})
resampled = _resample(df, "1h")
expected = expected_timestamps(ExpectedTimestampRequest(
    "2026-07-20", "2026-07-20", "1h", "equity", "XNYS", "regular",
))
legacy_named = expected_timestamps(ExpectedTimestampRequest(
    "2026-07-20", "2026-07-20", "1h", "equity", "US_EQUITIES", "regular",
))
four_days = expected_timestamps(ExpectedTimestampRequest(
    "2026-07-20", "2026-07-23", "1h", "equity", "US_EQUITIES", "regular",
))
partial = pd.DataFrame({
    "timestamp": four_days.delete(-1),
    "open": [100] * (len(four_days) - 1), "high": [100] * (len(four_days) - 1),
    "low": [100] * (len(four_days) - 1), "close": [100] * (len(four_days) - 1),
    "volume": [1] * (len(four_days) - 1),
})
partial_report = analyze(
    partial, "1h", "equity", requested_start="2026-07-20", requested_end="2026-07-23",
    calendar_id="US_EQUITIES",
)
print(json.dumps({
    "resampled": [value.isoformat() for value in resampled["timestamp"]],
    "expected": [value.isoformat() for value in expected],
    "legacy_named": [value.isoformat() for value in legacy_named],
    "partial_coverage": partial_report.coverage_pct,
    "partial_missing": partial_report.missing_timestamp_count,
    "partial_blocking": blocking_reasons(partial_report, "equity"),
}))
`
    const out = await Process.run([workspacePython || "python3", "-c", script], {
      env: { PYTHONPATH: root },
    })
    const result = JSON.parse(out.stdout.toString())
    expect(result.resampled).toEqual(result.expected)
    expect(result.legacy_named).toEqual(result.expected)
    expect(result.expected).toHaveLength(7)
    expect(result.expected.at(-1)).toContain("19:30:00")
    expect(result.partial_coverage).toBeGreaterThan(0.95)
    expect(result.partial_missing).toBe(1)
    expect(result.partial_blocking).toEqual([])
  })
})
