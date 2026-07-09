import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  parseMission,
  writeAlgo,
  DATA_NEWS_DIR,
  NEWS_HEADLINES_FILE_RE,
} from "../algo"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MISSION_YAML = `---
schema_version: 2
name: trump-china-swing
status: research
created: 2026-05-10
hypothesis: |
  US-China trade dynamics create swing opportunities in affected sectors.
scope:
  asset_class: equities
  universe: [BABA, JD, PDD, FXI]
  horizon: days
exit_conditions: |
  - Time stop: 5 trading days
  - Price stop: -5% from entry
---

# Trump-China trade swing strategy
`

let savedXdg: string | undefined

async function mkSandbox(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "finny-researcher-test-"))
}

async function seedAlgo(root: string, name: string = "trump-china-swing") {
  const mission = parseMission(
    MISSION_YAML.replace("trump-china-swing", name),
  )
  mission.frontmatter.name = name
  const { dir } = await writeAlgo({
    root,
    mission,
    current: "v01",
    versions: { v01: { strategy: "class Strategy:\n    pass\n" } },
  })
  return dir
}

async function setupEnv(): Promise<{ algosPath: string; algoDir: string }> {
  const xdgBase = await mkSandbox()
  const algosPath = path.join(xdgBase, "finny", "algos")
  await fs.mkdir(algosPath, { recursive: true })
  const algoDir = await seedAlgo(algosPath)
  process.env.XDG_DATA_HOME = xdgBase
  return { algosPath, algoDir }
}

// ---------------------------------------------------------------------------
// Tests — researcher agent definition
// ---------------------------------------------------------------------------

describe("researcher agent definition", () => {
  const AGENT_PATH = path.resolve(
    __dirname,
    "../../../../.opencode/agent/researcher.md",
  )

  let content: string

  beforeEach(async () => {
    content = await fs.readFile(AGENT_PATH, "utf8")
  })

  test("exists and has valid YAML frontmatter delimiters", () => {
    expect(content.startsWith("---")).toBe(true)
    expect(content.indexOf("---", 3)).toBeGreaterThan(3)
  })

  test("is configured as a hidden subagent", () => {
    expect(content).toContain("mode: subagent")
    expect(content).toContain("hidden: true")
  })

  test("has correct permissions including edit and external_directory", () => {
    expect(content).toContain('"*": deny')
    for (const perm of [
      "websearch",
      "webfetch",
      "finny_discord_read",
      "write",
      "edit",
      "read",
      "external_directory",
    ]) {
      expect(content).toContain(`${perm}: allow`)
    }
  })

  test("does not grant bash, glob, or grep permissions", () => {
    const lines = content.split("\n")
    const permLines = lines.filter(l => l.match(/^\s+["']?\w+["']?\s*:\s*allow/))
    for (const perm of ["bash", "glob", "grep"]) {
      const re = new RegExp(`^["']?${perm}["']?\\s*:`)
      expect(permLines.some(l => re.test(l.trim()))).toBe(false)
    }
  })

  test("documents the current prop-firm workflow contract", () => {
    for (const phrase of [
      "Read the active strategy mission",
      "BLOCKED: missing research topic",
      "last 14 days",
      "Use at most three high-signal sources",
      "Prefer execution/provenance sources",
      "Do not produce buy/sell labels",
      "write at most one compact markdown note directly under `workspace_news_dir`",
    ]) {
      expect(content).toContain(phrase)
    }
  })

  test("documents flat workspace news storage and identity tagging", () => {
    expect(content).toContain("Do not create `body/` or `headlines/` subfolders")
    expect(content).toContain("Only write inside `workspace_news_dir`")
    expect(content).toContain("artifact_paths")
    expect(content).toContain("Never reuse another algorithm's note or context")
  })

  test("documents returned brief sections", () => {
    for (const section of [
      "## Prop-Firm Research Brief",
      "### Execution / Market Microstructure",
      "### Data Provenance / Reproducibility",
      "### Risk Regime",
      "### Strategy Implications",
      "### Gaps / Caveats",
    ]) {
      expect(content).toContain(section)
    }
  })

  test("includes source failure and retry discipline", () => {
    expect(content).toContain("search/source access fails or rate-limits")
    expect(content).toContain("do not retry repeatedly")
    expect(content).toContain("return the best brief possible")
  })

  test("mentions web and configured Discord source paths", () => {
    expect(content).toContain("web")
    expect(content).toContain("configured Discord channels")
  })
})

// ---------------------------------------------------------------------------
// Tests — news data structure contract
// ---------------------------------------------------------------------------

describe("news data structure contract", () => {
  test("DATA_NEWS_DIR matches expected path", () => {
    expect(DATA_NEWS_DIR).toBe("data/news")
  })

  test("NEWS_HEADLINES_FILE_RE accepts valid date filenames", () => {
    expect(NEWS_HEADLINES_FILE_RE.test("2026-05-18.md")).toBe(true)
    expect(NEWS_HEADLINES_FILE_RE.test("2025-01-01.md")).toBe(true)
  })

  test("NEWS_HEADLINES_FILE_RE rejects invalid filenames", () => {
    expect(NEWS_HEADLINES_FILE_RE.test("headlines.md")).toBe(false)
    expect(NEWS_HEADLINES_FILE_RE.test("2026-5-18.md")).toBe(false)
    expect(NEWS_HEADLINES_FILE_RE.test("2026-05-18.txt")).toBe(false)
  })

  test("writeAlgo creates a flat news directory", async () => {
    const root = await mkSandbox()
    const mission = parseMission(MISSION_YAML)
    const { dir: algoDir } = await writeAlgo({
      root,
      mission,
      current: "v01",
      versions: { v01: { strategy: "class Strategy:\n    pass\n" } },
    })

    const newsStat = await fs.stat(path.join(algoDir, DATA_NEWS_DIR))
    expect(newsStat.isDirectory()).toBe(true)
    await expect(fs.stat(path.join(algoDir, DATA_NEWS_DIR, "headlines")).catch(() => null)).resolves.toBeNull()
    await expect(fs.stat(path.join(algoDir, DATA_NEWS_DIR, "body")).catch(() => null)).resolves.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// E2E workflow simulation
// ---------------------------------------------------------------------------

describe("E2E workflow: dispatch → write → read", () => {
  beforeEach(() => {
    savedXdg = process.env.XDG_DATA_HOME
  })

  afterEach(() => {
    if (savedXdg === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = savedXdg
    }
  })

  test("simulates researcher writing flat news files that Finny can read", async () => {
    const { algoDir } = await setupEnv()

    const newsDir = path.join(algoDir, DATA_NEWS_DIR)

    const headlinesContent = `# Headlines — 2026-05-18

| Time (UTC) | Headline | Source | Slug |
|------------|----------|--------|------|
| 09:15 | Trump announces 25% tariff reduction on Chinese goods | Reuters | trump-tariff-reduction-china |
| 10:30 | Beijing welcomes tariff reduction, signals reciprocal measures | SCMP | beijing-welcomes-tariff-reduction |
| 14:00 | Markets rally on US-China trade thaw | Bloomberg | markets-rally-trade-thaw |
`
    await fs.writeFile(path.join(newsDir, "2026-05-18.md"), headlinesContent)

    const bodyContent1 = `# Trump announces 25% tariff reduction on Chinese goods

**Date:** 2026-05-18 09:15 UTC
**Source:** Reuters
**Relevance:** Direct catalyst for BABA, JD, PDD positions in the swing strategy.

## Summary

President Trump announced a significant reduction in tariffs on Chinese imports,
cutting rates from 50% to 25% on a broad range of consumer and industrial goods.

## Key Facts

- Tariff reduction from 50% to 25% on $200B worth of goods
- Effective date: June 1, 2026

## Market Impact

BABA +4.2%, JD +3.8%, PDD +5.1% in pre-market. FXI ETF up 2.7%.

## Citations

- [Reuters: Trump slashes China tariffs](https://reuters.com/example) — Breaking news report
`
    await fs.writeFile(
      path.join(newsDir, "trump-tariff-reduction-china.md"),
      bodyContent1,
    )

    const bodyContent2 = `# Beijing welcomes tariff reduction

**Date:** 2026-05-18 10:30 UTC
**Source:** South China Morning Post

## Summary

China's Ministry of Commerce issued a statement welcoming the US tariff reduction.

## Citations

- [SCMP: Beijing responds](https://scmp.com/example) — First Chinese response
`
    await fs.writeFile(
      path.join(newsDir, "beijing-welcomes-tariff-reduction.md"),
      bodyContent2,
    )

    const newsFiles = await fs.readdir(newsDir)
    const dateFiles = newsFiles.filter((f) =>
      NEWS_HEADLINES_FILE_RE.test(f),
    )
    expect(dateFiles).toEqual(["2026-05-18.md"])

    const headlines = await fs.readFile(
      path.join(newsDir, "2026-05-18.md"),
      "utf8",
    )
    expect(headlines).toContain("Trump announces 25% tariff reduction")
    expect(headlines).toContain("trump-tariff-reduction-china")

    const body = await fs.readFile(
      path.join(newsDir, "trump-tariff-reduction-china.md"),
      "utf8",
    )
    expect(body).toContain("## Summary")
    expect(body).toContain("## Citations")
    expect(body).toContain("BABA +4.2%")

    const detailFiles = newsFiles.filter((f) => !NEWS_HEADLINES_FILE_RE.test(f)).sort()
    expect(detailFiles).toEqual([
      "beijing-welcomes-tariff-reduction.md",
      "trump-tariff-reduction-china.md",
    ])
  })

  test("simulates multiple days of research accumulating over time", async () => {
    const { algoDir } = await setupEnv()

    const newsDir = path.join(algoDir, DATA_NEWS_DIR)

    // Day 1
    await fs.writeFile(
      path.join(newsDir, "2026-05-17.md"),
      `# Headlines — 2026-05-17\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 08:00 | Rumours of tariff talks | FT | tariff-talks-rumours |\n`,
    )
    await fs.writeFile(
      path.join(newsDir, "tariff-talks-rumours.md"),
      `# Rumours of tariff talks\n\n**Date:** 2026-05-17 08:00 UTC\n**Source:** FT\n\n## Summary\n\nSources report...\n\n## Citations\n\n- [FT](https://ft.com/ex) — original report\n`,
    )

    // Day 2
    await fs.writeFile(
      path.join(newsDir, "2026-05-18.md"),
      `# Headlines — 2026-05-18\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 09:15 | Tariff cut confirmed | Reuters | tariff-cut-confirmed |\n`,
    )
    await fs.writeFile(
      path.join(newsDir, "tariff-cut-confirmed.md"),
      `# Tariff cut confirmed\n\n**Date:** 2026-05-18 09:15 UTC\n**Source:** Reuters\n\n## Summary\n\nConfirmed.\n\n## Citations\n\n- [Reuters](https://reuters.com/ex) — confirmation\n`,
    )

    // Verify accumulated across days
    const allNewsFiles = await fs.readdir(newsDir)
    const headlinesFiles = allNewsFiles.filter(f => NEWS_HEADLINES_FILE_RE.test(f)).sort()
    expect(headlinesFiles).toEqual(["2026-05-17.md", "2026-05-18.md"])

    const bodyFiles = allNewsFiles.filter((f) => !NEWS_HEADLINES_FILE_RE.test(f)).sort()
    expect(bodyFiles).toEqual([
      "tariff-cut-confirmed.md",
      "tariff-talks-rumours.md",
    ])
  })

  test("researcher output integrates with loadAlgo data structure", async () => {
    const { algoDir } = await setupEnv()

    const newsDir = path.join(algoDir, DATA_NEWS_DIR)

    await fs.writeFile(
      path.join(newsDir, "2026-05-18.md"),
      "# Headlines — 2026-05-18\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 12:00 | Test headline | TestSrc | test-slug |\n",
    )
    await fs.writeFile(
      path.join(newsDir, "test-slug.md"),
      "# Test headline\n\n**Date:** 2026-05-18 12:00 UTC\n\n## Summary\n\nTest.\n\n## Citations\n\n- [Test](https://example.com)\n",
    )

    // Verify algo data directory structure
    const newsEntries = await fs.readdir(newsDir)
    expect(newsEntries.sort()).toEqual(["2026-05-18.md", "test-slug.md"])
  })
})

// ---------------------------------------------------------------------------
// Prompt integration: Build owns implementation, Research plans, Chat stays read-only
// ---------------------------------------------------------------------------

describe("main agent prompts reference researcher", () => {
  const PROMPT_DIR = path.resolve(
    __dirname,
    "../../../opencode/src/agent/prompt",
  )

  test("Build prompt owns strategy implementation and backtests", async () => {
    const content = await fs.readFile(path.join(PROMPT_DIR, "finny-build.txt"), "utf8")
    expect(content).toContain("You are Finny Build: the implementation agent for trading strategies.")
    expect(content).toContain("Mandatory Pre-Build Subagents")
    expect(content).toContain("Save with `finny_algorithm_save`")
    expect(content).toContain("Run `finny_backtest`")
  })

  test("Research prompt plans strategies without saving or backtesting", async () => {
    const content = await fs.readFile(path.join(PROMPT_DIR, "finny-research.txt"), "utf8")
    expect(content).toContain("Research mode asks clarifying questions")
    expect(content).toContain("writes a plain-English strategy plan")
    expect(content).toContain("Do not call save, scaffold, validate, or backtest tools")
  })

  test("Chat prompt is read-only and hands build work to Build", async () => {
    const content = await fs.readFile(path.join(PROMPT_DIR, "finny-chat.txt"), "utf8")
    expect(content).toContain("Chat mode explains, summarizes, and answers questions")
    expect(content).toContain("does not save algorithms, create strategy code, or run new backtests")
    expect(content).toContain("Tell the user to switch to Build mode")
  })
})
