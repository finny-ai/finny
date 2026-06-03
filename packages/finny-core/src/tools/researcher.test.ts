import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  parseMission,
  writeAlgo,
  DATA_NEWS_HEADLINES_DIR,
  DATA_NEWS_BODY_DIR,
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

  test("has a step limit of 30", () => {
    expect(content).toContain("steps: 30")
  })

  test("documents all six workflow phases", () => {
    for (const phase of [
      "Understand the topic",
      "Gather data from Discord",
      "Gather data from the web",
      "Deduplicate",
      "Write output files",
      "Return a summary",
    ]) {
      expect(content).toContain(phase)
    }
  })

  test("documents headlines file format fields", () => {
    for (const field of ["Time (UTC)", "Headline", "Source", "Slug"]) {
      expect(content).toContain(field)
    }
  })

  test("documents body file format sections", () => {
    for (const section of [
      "## Summary",
      "## Key Facts",
      "## Market Impact",
      "## Citations",
    ]) {
      expect(content).toContain(section)
    }
  })

  test("includes tool call budget and 429 handling", () => {
    expect(content).toContain("Budget your tool calls")
    expect(content).toContain("429")
    expect(content).toContain("STOP gathering")
  })

  test("documents all Discord channels", () => {
    for (const ch of [
      "trump",
      "china-us-news",
      "congressional-trades",
      "market-news",
      "options-flow",
      "dark-pool",
    ]) {
      expect(content).toContain(ch)
    }
  })

  test("includes websearch fallback guidance", () => {
    expect(content).toContain("websearch` is unavailable")
    expect(content).toContain("webfetch")
  })
})

// ---------------------------------------------------------------------------
// Tests — news data structure contract
// ---------------------------------------------------------------------------

describe("news data structure contract", () => {
  test("DATA_NEWS_HEADLINES_DIR matches expected path", () => {
    expect(DATA_NEWS_HEADLINES_DIR).toBe("data/news/headlines")
  })

  test("DATA_NEWS_BODY_DIR matches expected path", () => {
    expect(DATA_NEWS_BODY_DIR).toBe("data/news/body")
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

  test("writeAlgo creates both headlines and body directories", async () => {
    const root = await mkSandbox()
    const mission = parseMission(MISSION_YAML)
    const { dir: algoDir } = await writeAlgo({
      root,
      mission,
      current: "v01",
      versions: { v01: { strategy: "class Strategy:\n    pass\n" } },
    })

    const headlinesStat = await fs.stat(
      path.join(algoDir, DATA_NEWS_HEADLINES_DIR),
    )
    const bodyStat = await fs.stat(path.join(algoDir, DATA_NEWS_BODY_DIR))
    expect(headlinesStat.isDirectory()).toBe(true)
    expect(bodyStat.isDirectory()).toBe(true)
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

  test("simulates researcher writing headlines and body files that Finny can read", async () => {
    const { algoDir } = await setupEnv()

    const headlinesDir = path.join(algoDir, DATA_NEWS_HEADLINES_DIR)
    const bodyDir = path.join(algoDir, DATA_NEWS_BODY_DIR)

    const headlinesContent = `# Headlines — 2026-05-18

| Time (UTC) | Headline | Source | Slug |
|------------|----------|--------|------|
| 09:15 | Trump announces 25% tariff reduction on Chinese goods | Reuters | trump-tariff-reduction-china |
| 10:30 | Beijing welcomes tariff reduction, signals reciprocal measures | SCMP | beijing-welcomes-tariff-reduction |
| 14:00 | Markets rally on US-China trade thaw | Bloomberg | markets-rally-trade-thaw |
`
    await fs.writeFile(path.join(headlinesDir, "2026-05-18.md"), headlinesContent)

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
      path.join(bodyDir, "trump-tariff-reduction-china.md"),
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
      path.join(bodyDir, "beijing-welcomes-tariff-reduction.md"),
      bodyContent2,
    )

    // Verify progressive disclosure: list headlines first
    const headlinesFiles = await fs.readdir(headlinesDir)
    const dateFiles = headlinesFiles.filter((f) =>
      NEWS_HEADLINES_FILE_RE.test(f),
    )
    expect(dateFiles).toEqual(["2026-05-18.md"])

    // Read headlines
    const headlines = await fs.readFile(
      path.join(headlinesDir, "2026-05-18.md"),
      "utf8",
    )
    expect(headlines).toContain("Trump announces 25% tariff reduction")
    expect(headlines).toContain("trump-tariff-reduction-china")

    // Read body file on demand
    const body = await fs.readFile(
      path.join(bodyDir, "trump-tariff-reduction-china.md"),
      "utf8",
    )
    expect(body).toContain("## Summary")
    expect(body).toContain("## Citations")
    expect(body).toContain("BABA +4.2%")

    // List all body files
    const bodyFiles = await fs.readdir(bodyDir)
    expect(bodyFiles.sort()).toEqual([
      "beijing-welcomes-tariff-reduction.md",
      "trump-tariff-reduction-china.md",
    ])
  })

  test("simulates multiple days of research accumulating over time", async () => {
    const { algoDir } = await setupEnv()

    const headlinesDir = path.join(algoDir, DATA_NEWS_HEADLINES_DIR)
    const bodyDir = path.join(algoDir, DATA_NEWS_BODY_DIR)

    // Day 1
    await fs.writeFile(
      path.join(headlinesDir, "2026-05-17.md"),
      `# Headlines — 2026-05-17\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 08:00 | Rumours of tariff talks | FT | tariff-talks-rumours |\n`,
    )
    await fs.writeFile(
      path.join(bodyDir, "tariff-talks-rumours.md"),
      `# Rumours of tariff talks\n\n**Date:** 2026-05-17 08:00 UTC\n**Source:** FT\n\n## Summary\n\nSources report...\n\n## Citations\n\n- [FT](https://ft.com/ex) — original report\n`,
    )

    // Day 2
    await fs.writeFile(
      path.join(headlinesDir, "2026-05-18.md"),
      `# Headlines — 2026-05-18\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 09:15 | Tariff cut confirmed | Reuters | tariff-cut-confirmed |\n`,
    )
    await fs.writeFile(
      path.join(bodyDir, "tariff-cut-confirmed.md"),
      `# Tariff cut confirmed\n\n**Date:** 2026-05-18 09:15 UTC\n**Source:** Reuters\n\n## Summary\n\nConfirmed.\n\n## Citations\n\n- [Reuters](https://reuters.com/ex) — confirmation\n`,
    )

    // Verify accumulated across days
    const headlinesFiles = (await fs.readdir(headlinesDir)).filter(f => NEWS_HEADLINES_FILE_RE.test(f)).sort()
    expect(headlinesFiles).toEqual(["2026-05-17.md", "2026-05-18.md"])

    const bodyFiles = (await fs.readdir(bodyDir)).sort()
    expect(bodyFiles).toEqual([
      "tariff-cut-confirmed.md",
      "tariff-talks-rumours.md",
    ])
  })

  test("researcher output integrates with loadAlgo data structure", async () => {
    const { algoDir } = await setupEnv()

    const headlinesDir = path.join(algoDir, DATA_NEWS_HEADLINES_DIR)
    const bodyDir = path.join(algoDir, DATA_NEWS_BODY_DIR)

    await fs.writeFile(
      path.join(headlinesDir, "2026-05-18.md"),
      "# Headlines — 2026-05-18\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 12:00 | Test headline | TestSrc | test-slug |\n",
    )
    await fs.writeFile(
      path.join(bodyDir, "test-slug.md"),
      "# Test headline\n\n**Date:** 2026-05-18 12:00 UTC\n\n## Summary\n\nTest.\n\n## Citations\n\n- [Test](https://example.com)\n",
    )

    // Verify algo data directory structure
    const newsDir = path.join(algoDir, "data", "news")
    const newsEntries = await fs.readdir(newsDir)
    expect(newsEntries.sort()).toEqual(["body", "headlines"])

    const hFiles = await fs.readdir(path.join(newsDir, "headlines"))
    expect(hFiles.filter(f => f.endsWith(".md"))).toContain("2026-05-18.md")

    const bFiles = await fs.readdir(path.join(newsDir, "body"))
    expect(bFiles).toContain("test-slug.md")
  })
})

// ---------------------------------------------------------------------------
// Prompt integration: all three mode prompts reference the research workflow
// ---------------------------------------------------------------------------

describe("main agent prompts reference researcher", () => {
  const PROMPT_DIR = path.resolve(
    __dirname,
    "../../../opencode/src/agent/prompt",
  )

  const PROMPT_FILES = ["finny-build.txt", "finny-research.txt", "finny-chat.txt"]

  test.each(PROMPT_FILES)("%s mentions the researcher workflow", async (file) => {
    const content = await fs.readFile(path.join(PROMPT_DIR, file), "utf8")
    // finny-build.txt uses inline researcher prompts; others still reference the dispatch tool
    expect(content).toMatch(/finny_research_dispatch|researcher/)
  })

  test.each(PROMPT_FILES)("%s describes a background dispatch workflow", async (file) => {
    const content = await fs.readFile(path.join(PROMPT_DIR, file), "utf8")
    expect(content).toContain("background")
    expect(content).toContain("researcher")
  })

  test.each(PROMPT_FILES)("%s includes the Deep Research section", async (file) => {
    const content = await fs.readFile(path.join(PROMPT_DIR, file), "utf8")
    expect(content).toContain("Deep Research")
  })
})
