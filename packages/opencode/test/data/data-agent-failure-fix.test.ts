import { describe, expect, test } from "bun:test"
import PROMPT_DATA_EXTRACTOR from "../../src/agent/prompt/finny-data-extractor.txt"
import PROMPT_BUILD from "../../src/agent/prompt/finny-build.txt"
import fs from "node:fs"
import path from "node:path"

const DATA_COOKBOOK = fs.readFileSync(path.join(import.meta.dir, "../../../../data-agent/instructions.md"), "utf8")

describe("data_extractor prompt hardening", () => {
  test("keeps model-facing guidance compact and autonomous", () => {
    expect(PROMPT_DATA_EXTRACTOR.length).toBeLessThan(2_000)
    expect(PROMPT_DATA_EXTRACTOR).toContain("Use your judgment")
    expect(PROMPT_DATA_EXTRACTOR).toContain("search the web")
    expect(PROMPT_DATA_EXTRACTOR).toContain("official provider documentation")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("finny-provider-")
    expect(PROMPT_DATA_EXTRACTOR).not.toContain("Return Checklist")
  })

  test("keeps the source notes concise and provider-agnostic", () => {
    expect(DATA_COOKBOOK.length).toBeLessThan(2_000)
    expect(DATA_COOKBOOK).toContain("Use the exact request supplied by Finny")
    expect(DATA_COOKBOOK).toContain("timestamp,open,high,low,close,volume")
    expect(DATA_COOKBOOK).toContain("fill missing ranges")
    expect(DATA_COOKBOOK).not.toContain("https://")
    expect(DATA_COOKBOOK).not.toContain("ALPACA_API_KEY_ID")
    expect(DATA_COOKBOOK).not.toContain("BINANCE_BASE_URL")
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
