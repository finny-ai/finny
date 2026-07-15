import { describe, expect, test } from "bun:test"
import PROMPT_DATA_EXTRACTOR from "../../src/agent/prompt/finny-data-extractor.txt"
import PROMPT_BUILD from "../../src/agent/prompt/finny-build.txt"

describe("data_extractor prompt hardening", () => {
  test("limits tools to read, skill, and bash only", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("only tools are `read`, `skill`, and `bash`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Never call `glob`, `write`, `edit`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("removed `finny_extract_data` tool")
  })

  test("requires CSV plus manifest under allowed_data_dir only", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("exactly one OHLCV CSV plus one `.manifest.json`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("No repo-local `_template/data` artifacts")
    expect(PROMPT_DATA_EXTRACTOR).toContain("no `packages/opencode/data/news`")
  })

  test("requires full digest identity fields and usable_for_parent", () => {
    for (const field of [
      "requested_algorithm_name",
      "workspace_slug",
      "requested_symbol",
      "actual_symbol",
      "requested_interval",
      "actual_interval",
      "requested_asset_class",
      "actual_asset_class",
      "requested_start",
      "requested_end",
      "actual_start",
      "actual_end",
      "artifact_paths",
      "run_id",
      "usable_for_parent",
    ]) {
      expect(PROMPT_DATA_EXTRACTOR).toContain(field)
    }
  })

  test("forbids estimated metrics and uses not_returned", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Do not estimate missing stats")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`not_returned`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("instead of guessing mean, std dev")
  })

  test("uses shared strict quality vocabulary", () => {
    for (const label of ["duplicates", "gaps", "invalid_ohlc", "zero_volume", "outliers", "partial_provider_coverage"]) {
      expect(PROMPT_DATA_EXTRACTOR).toContain(label)
    }
  })

  test("blocks runtime/source unavailable cleanly", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("BLOCKED: runtime/source unavailable")
    expect(PROMPT_DATA_EXTRACTOR).toContain("Do not install Python packages")
  })

  test("hard-stops provider-limit partial public fetch after configured sources fail", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("BLOCKED: provider limit")
    expect(PROMPT_DATA_EXTRACTOR).toContain("SPY 5m")
    expect(PROMPT_DATA_EXTRACTOR).toContain("try Alpaca first")
    expect(PROMPT_DATA_EXTRACTOR).toContain("try Polygon before yfinance")
    expect(PROMPT_DATA_EXTRACTOR).toContain("free-plan entitlement")
  })

  test("requires Binance pagination before partial coverage", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("Binance public klines require no API key and are paginated at 1000 bars")
    expect(PROMPT_DATA_EXTRACTOR).toContain("cursor through all pages needed")
    expect(PROMPT_DATA_EXTRACTOR).toContain("A 1000-row Binance kline page is not provider-truncated partial coverage")
    expect(PROMPT_DATA_EXTRACTOR).toContain("BINANCE_BASE_URL")
    expect(PROMPT_DATA_EXTRACTOR).toContain("https://data-api.binance.vision")
    expect(PROMPT_DATA_EXTRACTOR).toContain("require no API key")
  })

  test("loads provider skills before provider fetches", () => {
    expect(PROMPT_DATA_EXTRACTOR).toContain("call `skill` exactly once for that provider")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-binance`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-polygon`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("`finny-provider-yfinance`")
    expect(PROMPT_DATA_EXTRACTOR).toContain("before the first provider fetch")
  })
})

describe("build prompt state machine ordering", () => {
  test("keeps selected evidence ahead of dependent scaffolding without a universal gate", () => {
    expect(PROMPT_BUILD).toContain("Recommended Pre-Build Evidence")
    expect(PROMPT_BUILD).toContain("highly recommended but not universally mandatory")
    expect(PROMPT_BUILD).toMatch(/Decide whether pre-build evidence materially improves[\s\S]*If evidence was launched[\s\S]*Then scaffold\/save\/validate\/backtest/)
    expect(PROMPT_BUILD).toContain("Do not call `finny_algorithm_scaffold` or `finny_algorithm_save` in parallel with selected evidence")
    expect(PROMPT_BUILD).toContain("A fixed `data_extractor` plus `news_agent` pair is never required")
    expect(PROMPT_BUILD).toContain("Build structured `docsInput` for `finny_algorithm_save`")
    expect(PROMPT_BUILD).toContain("never hand-author mission YAML")
  })

  test("selects sec_agent for filing-dependent builds", () => {
    expect(PROMPT_BUILD).toContain("Use `sec_agent` when the strategy depends on filings")
    expect(PROMPT_BUILD).toContain("ownership, insider activity, or institutional holdings")
  })
})
