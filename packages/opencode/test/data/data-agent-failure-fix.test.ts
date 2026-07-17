import { describe, expect, test } from "bun:test"
import PROMPT_DATA_EXTRACTOR from "../../src/agent/prompt/finny-data-extractor.txt"
import PROMPT_BUILD from "../../src/agent/prompt/finny-build.txt"
import fs from "node:fs"
import path from "node:path"

const DATA_COOKBOOK = fs.readFileSync(path.join(import.meta.dir, "../../../../data-agent/instructions.md"), "utf8")

describe("data_extractor prompt hardening", () => {
  test("keeps the subagent prompt compact and tool-scoped", () => {
    expect(PROMPT_DATA_EXTRACTOR.split("\n").length).toBeLessThanOrEqual(50)
    expect(PROMPT_DATA_EXTRACTOR).toContain("Use only `read`, `skill`, `bash`, and `finny_dataset_evidence_finalize`")
  })

  test("accepts the compact parent handoff and inclusive end date", () => {
    for (const field of [
      "`symbol`",
      "`start_date`",
      "`end_date`",
      "`end_date_inclusive`",
      "`provider`",
      "`workspace`",
      "`asset_class`",
      "`interval`",
    ]) {
      expect(PROMPT_DATA_EXTRACTOR).toContain(field)
    }
    expect(PROMPT_DATA_EXTRACTOR).toContain("Keep that date unchanged in the evidence")
  })

  test("stores CSVs in the workspace and leaves manifests to the finalizer", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("`timestamp,open,high,low,close,volume`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("relative path under `workspace`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Call it once for each verified CSV")
    expect(PROMPT_DATA_EXTRACTOR).toContain("never create or edit a manifest yourself")
    expect(PROMPT_DATA_EXTRACTOR).toContain("analysis_summary_path")
  })

  test("keeps detailed provider and quality policy in the cookbook", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Always read repo-root `data-agent/instructions.md`")
    expect(DATA_COOKBOOK).toContain("usable_for_parent")
    expect(DATA_COOKBOOK).toContain("invalid_ohlc")
    expect(DATA_COOKBOOK).toContain("partial_provider_coverage")
    expect(DATA_COOKBOOK).toContain("## Alpaca Market Data")
    expect(DATA_COOKBOOK).toContain("Polygon")
  })

  test("keeps Binance pagination details in the cookbook", () => {
    expect(DATA_COOKBOOK).toContain("Binance returns at most 1000 klines per request")
    expect(DATA_COOKBOOK).toContain("page size, not a")
    expect(DATA_COOKBOOK).toContain("startTime = last_open_time + interval_ms")
    expect(DATA_COOKBOOK).toContain("BINANCE_BASE_URL")
  })

  test("loads provider skills before provider fetches", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Load the matching provider skill before using that provider")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-binance`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-polygon`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-yfinance`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-alpaca`")
  })

  test("keeps open-session equity extraction inside the delayed regular-session window", () => {
    expect(DATA_COOKBOOK).toContain("last fully completed XNYS session")
    expect(DATA_COOKBOOK).toContain("Cap it at `now - 20 minutes`")
    expect(DATA_COOKBOOK).toContain("keep regular-session timestamps only")
    expect(DATA_COOKBOOK).toMatch(/Never rename\s+a file that\s+ends on yesterday so it can contain today's bars/)
  })
})

describe("build prompt state machine ordering", () => {
  test("keeps selected evidence ahead of dependent scaffolding without a universal gate", () => {
    expect(PROMPT_BUILD).toContain("Recommended Pre-Build Evidence")
    expect(PROMPT_BUILD).toContain("highly recommended but not universally mandatory")
    expect(PROMPT_BUILD).toMatch(
      /Decide whether pre-build evidence materially improves[\s\S]*If evidence was launched[\s\S]*Then scaffold\/save\/validate\/backtest/,
    )
    expect(PROMPT_BUILD).toContain(
      "Do not call `finny_algorithm_scaffold` or `finny_algorithm_save` in parallel with selected evidence",
    )
    expect(PROMPT_BUILD).toContain("A fixed `data_extractor` plus `news_agent` pair is never required")
    expect(PROMPT_BUILD).toContain("Build structured `docsInput` for `finny_algorithm_save`")
    expect(PROMPT_BUILD).toContain("never hand-author mission YAML")
  })

  test("selects sec_agent for filing-dependent builds", () => {
    expect(PROMPT_BUILD).toContain("Use `sec_agent` when the strategy depends on filings")
    expect(PROMPT_BUILD).toContain("ownership, insider activity, or institutional holdings")
  })
})
