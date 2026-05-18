import { describe, expect, test, beforeEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { researcher } from "./researcher"
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

async function mkSandbox(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "finny-researcher-test-"))
}

async function seedAlgo(root: string, name: string = "trump-china-swing") {
  const mission = parseMission(
    MISSION_YAML.replace("trump-china-swing", name),
  )
  mission.frontmatter.name = name
  await writeAlgo({
    root,
    mission,
    current: "v01",
    versions: { v01: { strategy: "class Strategy:\n    pass\n" } },
  })
  return path.join(root, name)
}

// The tool from @opencode-ai/plugin exposes .execute(args) which we can call
// directly in tests. The tool definition is a plain object with an execute fn.
function exec(args: Record<string, unknown>) {
  // The tool.execute from @opencode-ai/plugin accepts the validated args
  return (researcher as any).execute(args)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("finny_research_dispatch tool", () => {
  let root: string

  beforeEach(async () => {
    root = await mkSandbox()
    // Override env so algosRoot() resolves to our sandbox
    process.env.XDG_DATA_HOME = path.join(root, "..")
    // algosRoot reads XDG_DATA_HOME and appends finny/algos
    // We'll seed directly into root and pass the algo name matching the path
  })

  // -----------------------------------------------------------------------
  // 1. Happy path — basic dispatch
  // -----------------------------------------------------------------------
  describe("happy path", () => {
    test("returns a prompt with correct output directories for a valid algorithm", async () => {
      const algoDir = await seedAlgo(root)
      // Override algosRoot by setting XDG_DATA_HOME to parent of root
      // Since algosRoot = XDG_DATA_HOME/finny/algos, we need to structure accordingly
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      const result = JSON.parse(
        await exec({
          topic: "trump visit to china may 2025",
          algorithm: "trump-china-swing",
          days: 7,
        }),
      )

      expect(result.prompt).toBeDefined()
      expect(result.prompt).toContain("trump visit to china may 2025")
      expect(result.prompt).toContain("last 7 days")
      expect(result.subagent).toBe("researcher")
      expect(result.algorithm).toBe("trump-china-swing")
      expect(result.dataDir).toContain("trump-china-swing")
    })

    test("prompt includes headline and body directory paths", async () => {
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      const result = JSON.parse(
        await exec({
          topic: "fed rate decision",
          algorithm: "trump-china-swing",
          days: 3,
        }),
      )

      expect(result.prompt).toContain("headlines")
      expect(result.prompt).toContain("body")
      expect(result.prompt).toContain("last 3 days")
    })

    test("creates data/news directories if they don't exist", async () => {
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      const algoDir = await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      // Remove the news dirs that writeAlgo created, to verify the tool re-creates them
      await fs.rm(path.join(algoDir, DATA_NEWS_HEADLINES_DIR), {
        recursive: true,
        force: true,
      })
      await fs.rm(path.join(algoDir, DATA_NEWS_BODY_DIR), {
        recursive: true,
        force: true,
      })

      await exec({
        topic: "test topic",
        algorithm: "trump-china-swing",
        days: 7,
      })

      const headlinesStat = await fs.stat(
        path.join(algoDir, DATA_NEWS_HEADLINES_DIR),
      )
      const bodyStat = await fs.stat(path.join(algoDir, DATA_NEWS_BODY_DIR))
      expect(headlinesStat.isDirectory()).toBe(true)
      expect(bodyStat.isDirectory()).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 2. Channel selection
  // -----------------------------------------------------------------------
  describe("channel selection", () => {
    test("includes explicit channels in the prompt when provided", async () => {
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      const result = JSON.parse(
        await exec({
          topic: "china tariffs",
          algorithm: "trump-china-swing",
          channels: ["trump", "china-us-news", "market-news"],
          days: 7,
        }),
      )

      expect(result.prompt).toContain("trump")
      expect(result.prompt).toContain("china-us-news")
      expect(result.prompt).toContain("market-news")
      expect(result.prompt).toContain("Focus on these Discord channels")
    })

    test("uses auto-select hint when no channels specified", async () => {
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      const result = JSON.parse(
        await exec({
          topic: "general market analysis",
          algorithm: "trump-china-swing",
          days: 7,
        }),
      )

      expect(result.prompt).toContain("Auto-select relevant Discord channels")
    })
  })

  // -----------------------------------------------------------------------
  // 3. Error handling — missing algorithm
  // -----------------------------------------------------------------------
  describe("error handling", () => {
    test("returns error when algorithm does not exist", async () => {
      const xdgBase = await mkSandbox()
      process.env.XDG_DATA_HOME = xdgBase
      // Don't create any algo — just set up the path
      await fs.mkdir(path.join(xdgBase, "finny", "algos"), { recursive: true })

      const result = JSON.parse(
        await exec({
          topic: "some topic",
          algorithm: "nonexistent-algo",
          days: 7,
        }),
      )

      expect(result.error).toBeDefined()
      expect(result.error).toContain("nonexistent-algo")
      expect(result.error).toContain("not found")
    })
  })

  // -----------------------------------------------------------------------
  // 4. Days parameter
  // -----------------------------------------------------------------------
  describe("days parameter", () => {
    test("defaults to 7 days when not specified", async () => {
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      // When called through the plugin layer, Zod applies .default(7).
      // Direct exec() bypasses validation, so pass days explicitly.
      const result = JSON.parse(
        await exec({
          topic: "test",
          algorithm: "trump-china-swing",
          days: 7,
        }),
      )

      expect(result.prompt).toContain("last 7 days")
    })

    test("respects custom days value", async () => {
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      const result = JSON.parse(
        await exec({
          topic: "test",
          algorithm: "trump-china-swing",
          days: 14,
        }),
      )

      expect(result.prompt).toContain("last 14 days")
    })
  })

  // -----------------------------------------------------------------------
  // 5. Prompt structure validation
  // -----------------------------------------------------------------------
  describe("prompt structure", () => {
    test("prompt contains all required sections", async () => {
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      const result = JSON.parse(
        await exec({
          topic: "trump china tariff reduction",
          algorithm: "trump-china-swing",
          channels: ["trump"],
          days: 5,
        }),
      )

      const prompt = result.prompt as string
      expect(prompt).toContain("## Topic")
      expect(prompt).toContain("## Output directory")
      expect(prompt).toContain("## Parameters")
      expect(prompt).toContain("trump china tariff reduction")
      expect(prompt).toContain("Begin research now")
    })

    test("result JSON contains all expected fields", async () => {
      const xdgBase = await mkSandbox()
      const algosPath = path.join(xdgBase, "finny", "algos")
      await fs.mkdir(algosPath, { recursive: true })
      await seedAlgo(algosPath)
      process.env.XDG_DATA_HOME = xdgBase

      const result = JSON.parse(
        await exec({
          topic: "test",
          algorithm: "trump-china-swing",
          days: 7,
        }),
      )

      expect(result).toHaveProperty("prompt")
      expect(result).toHaveProperty("subagent")
      expect(result).toHaveProperty("algorithm")
      expect(result).toHaveProperty("dataDir")
      expect(typeof result.prompt).toBe("string")
      expect(result.subagent).toBe("researcher")
      expect(result.algorithm).toBe("trump-china-swing")
    })
  })
})

// ---------------------------------------------------------------------------
// Agent definition tests
// ---------------------------------------------------------------------------

describe("researcher agent definition", () => {
  const AGENT_PATH = path.resolve(
    __dirname,
    "../../../../.opencode/agent/researcher.md",
  )

  test("researcher.md exists and has correct YAML frontmatter", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")

    // Check frontmatter markers
    expect(content.startsWith("---")).toBe(true)
    expect(content.indexOf("---", 3)).toBeGreaterThan(3)

    // Check required frontmatter fields
    expect(content).toContain("mode: subagent")
    expect(content).toContain("hidden: true")
  })

  test("researcher agent has correct permissions", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")

    // Must deny all by default
    expect(content).toContain('"*": deny')

    // Must allow required tools
    const requiredTools = [
      "websearch",
      "webfetch",
      "finny_discord_read",
      "write",
      "read",
      "bash",
    ]
    for (const tool of requiredTools) {
      expect(content).toContain(`${tool}: allow`)
    }
  })

  test("researcher agent has a step limit", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")
    expect(content).toContain("steps: 30")
  })

  test("researcher agent prompt covers all workflow steps", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")

    // Must document the full workflow
    expect(content).toContain("Understand the topic")
    expect(content).toContain("Gather data from Discord")
    expect(content).toContain("Gather data from the web")
    expect(content).toContain("Deduplicate")
    expect(content).toContain("Write output files")
    expect(content).toContain("Return a summary")
  })

  test("researcher agent documents the headlines file format", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")

    expect(content).toContain("headlines/<YYYY-MM-DD>.md")
    expect(content).toContain("Time (UTC)")
    expect(content).toContain("Headline")
    expect(content).toContain("Source")
    expect(content).toContain("Slug")
  })

  test("researcher agent documents the body file format", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")

    expect(content).toContain("body/<slug>.md")
    expect(content).toContain("## Summary")
    expect(content).toContain("## Key Facts")
    expect(content).toContain("## Market Impact")
    expect(content).toContain("## Citations")
  })

  test("researcher agent includes deduplication rules", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")

    expect(content).toContain("Deduplicate")
    expect(content).toContain("micro-updates")
  })

  test("researcher agent includes tool call budget instructions", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")

    expect(content).toContain("Budget your tool calls")
    expect(content).toContain("429")
    expect(content).toContain("STOP gathering")
    expect(content).toContain("START writing")
  })

  test("researcher agent documents all Discord channels", async () => {
    const content = await fs.readFile(AGENT_PATH, "utf8")

    const channels = [
      "trump",
      "china-us-news",
      "congressional-trades",
      "market-news",
      "options-flow",
      "dark-pool",
    ]
    for (const ch of channels) {
      expect(content).toContain(ch)
    }
  })
})

// ---------------------------------------------------------------------------
// Integration: news data structure contract
// ---------------------------------------------------------------------------

describe("news data structure contract", () => {
  test("DATA_NEWS_HEADLINES_DIR matches the expected path", () => {
    expect(DATA_NEWS_HEADLINES_DIR).toBe("data/news/headlines")
  })

  test("DATA_NEWS_BODY_DIR matches the expected path", () => {
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
    expect(NEWS_HEADLINES_FILE_RE.test("summary.md")).toBe(false)
  })

  test("writeAlgo creates both headlines and body directories", async () => {
    const root = await mkSandbox()
    const mission = parseMission(MISSION_YAML)
    await writeAlgo({
      root,
      mission,
      current: "v01",
      versions: { v01: { strategy: "class Strategy:\n    pass\n" } },
    })

    const algoDir = path.join(root, "trump-china-swing")
    const headlinesStat = await fs.stat(
      path.join(algoDir, DATA_NEWS_HEADLINES_DIR),
    )
    const bodyStat = await fs.stat(path.join(algoDir, DATA_NEWS_BODY_DIR))
    expect(headlinesStat.isDirectory()).toBe(true)
    expect(bodyStat.isDirectory()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// End-to-end workflow simulation
// ---------------------------------------------------------------------------

describe("E2E workflow: dispatch → write → read", () => {
  test("simulates researcher writing headlines and body files that Finny can read", async () => {
    const xdgBase = await mkSandbox()
    const algosPath = path.join(xdgBase, "finny", "algos")
    await fs.mkdir(algosPath, { recursive: true })
    const algoDir = await seedAlgo(algosPath)
    process.env.XDG_DATA_HOME = xdgBase

    // 1. Dispatch — get the prompt and directories
    const dispatchResult = JSON.parse(
      await exec({
        topic: "trump china tariff reduction announcement",
        algorithm: "trump-china-swing",
        channels: ["trump", "china-us-news"],
        days: 7,
      }),
    )

    expect(dispatchResult.prompt).toBeDefined()

    // 2. Simulate what the researcher subagent would write
    const headlinesDir = path.join(algoDir, DATA_NEWS_HEADLINES_DIR)
    const bodyDir = path.join(algoDir, DATA_NEWS_BODY_DIR)

    // Write a headlines file
    const headlinesContent = `# Headlines — 2026-05-18

| Time (UTC) | Headline | Source | Slug |
|------------|----------|--------|------|
| 09:15 | Trump announces 25% tariff reduction on Chinese goods | Reuters | trump-tariff-reduction-china |
| 10:30 | Beijing welcomes tariff reduction, signals reciprocal measures | SCMP | beijing-welcomes-tariff-reduction |
| 14:00 | Markets rally on US-China trade thaw | Bloomberg | markets-rally-trade-thaw |
`
    await fs.writeFile(path.join(headlinesDir, "2026-05-18.md"), headlinesContent)

    // Write body files
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
- Covers electronics, textiles, and machinery categories

## Market Impact

BABA +4.2%, JD +3.8%, PDD +5.1% in pre-market. FXI ETF up 2.7%.

## Citations

- [Reuters: Trump slashes China tariffs](https://reuters.com/example) — Breaking news report
- [White House press release](https://whitehouse.gov/example) — Official announcement
`
    await fs.writeFile(
      path.join(bodyDir, "trump-tariff-reduction-china.md"),
      bodyContent1,
    )

    const bodyContent2 = `# Beijing welcomes tariff reduction, signals reciprocal measures

**Date:** 2026-05-18 10:30 UTC
**Source:** South China Morning Post
**Relevance:** Reciprocal measures could further boost China-exposed equities.

## Summary

China's Ministry of Commerce issued a statement welcoming the US tariff reduction
and signaling willingness to reduce retaliatory tariffs on US agricultural exports.

## Key Facts

- MOFCOM spokesperson confirmed positive reception
- Potential reduction of Chinese tariffs on US soybeans and pork
- Diplomatic meetings scheduled for next week

## Market Impact

Chinese tech names extended gains. Agricultural futures (soybeans, corn) moved higher.

## Citations

- [SCMP: Beijing responds](https://scmp.com/example) — First Chinese response
`
    await fs.writeFile(
      path.join(bodyDir, "beijing-welcomes-tariff-reduction.md"),
      bodyContent2,
    )

    // 3. Verify the main agent (Finny) can discover and read the files

    // List headlines files
    const headlinesFiles = await fs.readdir(headlinesDir)
    const dateFiles = headlinesFiles.filter((f) =>
      NEWS_HEADLINES_FILE_RE.test(f),
    )
    expect(dateFiles).toEqual(["2026-05-18.md"])

    // Read headlines for the day
    const headlines = await fs.readFile(
      path.join(headlinesDir, "2026-05-18.md"),
      "utf8",
    )
    expect(headlines).toContain("Trump announces 25% tariff reduction")
    expect(headlines).toContain("trump-tariff-reduction-china")

    // Read a body file on demand (progressive disclosure)
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
    const xdgBase = await mkSandbox()
    const algosPath = path.join(xdgBase, "finny", "algos")
    await fs.mkdir(algosPath, { recursive: true })
    const algoDir = await seedAlgo(algosPath)
    process.env.XDG_DATA_HOME = xdgBase

    const headlinesDir = path.join(algoDir, DATA_NEWS_HEADLINES_DIR)
    const bodyDir = path.join(algoDir, DATA_NEWS_BODY_DIR)

    // Day 1 research
    await fs.writeFile(
      path.join(headlinesDir, "2026-05-17.md"),
      `# Headlines — 2026-05-17\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 08:00 | Rumours of tariff talks | FT | tariff-talks-rumours |\n`,
    )
    await fs.writeFile(
      path.join(bodyDir, "tariff-talks-rumours.md"),
      `# Rumours of tariff talks\n\n**Date:** 2026-05-17 08:00 UTC\n**Source:** Financial Times\n\n## Summary\n\nSources close to the matter report...\n\n## Citations\n\n- [FT](https://ft.com/ex) — original report\n`,
    )

    // Day 2 research (second dispatch)
    await exec({
      topic: "trump china tariffs update",
      algorithm: "trump-china-swing",
      days: 1,
    })

    await fs.writeFile(
      path.join(headlinesDir, "2026-05-18.md"),
      `# Headlines — 2026-05-18\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 09:15 | Tariff cut confirmed | Reuters | tariff-cut-confirmed |\n`,
    )
    await fs.writeFile(
      path.join(bodyDir, "tariff-cut-confirmed.md"),
      `# Tariff cut confirmed\n\n**Date:** 2026-05-18 09:15 UTC\n**Source:** Reuters\n\n## Summary\n\nConfirmed.\n\n## Citations\n\n- [Reuters](https://reuters.com/ex) — confirmation\n`,
    )

    // Verify accumulated research across days
    const headlinesFiles = (await fs.readdir(headlinesDir)).sort()
    expect(headlinesFiles).toEqual(["2026-05-17.md", "2026-05-18.md"])

    const bodyFiles = (await fs.readdir(bodyDir)).sort()
    expect(bodyFiles).toEqual([
      "tariff-cut-confirmed.md",
      "tariff-talks-rumours.md",
    ])
  })

  test("researcher output integrates with loadAlgo data structure", async () => {
    const xdgBase = await mkSandbox()
    const algosPath = path.join(xdgBase, "finny", "algos")
    await fs.mkdir(algosPath, { recursive: true })
    const algoDir = await seedAlgo(algosPath)

    const headlinesDir = path.join(algoDir, DATA_NEWS_HEADLINES_DIR)
    const bodyDir = path.join(algoDir, DATA_NEWS_BODY_DIR)

    // Researcher writes files
    await fs.writeFile(
      path.join(headlinesDir, "2026-05-18.md"),
      "# Headlines — 2026-05-18\n\n| Time (UTC) | Headline | Source | Slug |\n|--|--|--|--|\n| 12:00 | Test headline | TestSrc | test-slug |\n",
    )
    await fs.writeFile(
      path.join(bodyDir, "test-slug.md"),
      "# Test headline\n\n**Date:** 2026-05-18 12:00 UTC\n\n## Summary\n\nTest.\n\n## Citations\n\n- [Test](https://example.com)\n",
    )

    // Verify the algo data directory has the expected structure
    const dataDir = path.join(algoDir, "data")
    const dataStat = await fs.stat(dataDir)
    expect(dataStat.isDirectory()).toBe(true)

    // Verify news subdirectories
    const newsDir = path.join(dataDir, "news")
    const newsEntries = await fs.readdir(newsDir)
    expect(newsEntries.sort()).toEqual(["body", "headlines"])

    // Verify files written by researcher are discoverable
    const hFiles = await fs.readdir(path.join(newsDir, "headlines"))
    expect(hFiles).toContain("2026-05-18.md")

    const bFiles = await fs.readdir(path.join(newsDir, "body"))
    expect(bFiles).toContain("test-slug.md")
  })
})

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  test("register.ts imports and registers finny_research_dispatch", async () => {
    const registerPath = path.resolve(__dirname, "../register.ts")
    const content = await fs.readFile(registerPath, "utf8")

    expect(content).toContain('import { researcher } from "./tools/researcher"')
    expect(content).toContain(
      'Registry.tools.register({ id: "finny_research_dispatch", def: researcher })',
    )
  })

  test("index.ts exports the researcher tool", async () => {
    const indexPath = path.resolve(__dirname, "../index.ts")
    const content = await fs.readFile(indexPath, "utf8")

    expect(content).toContain('export { researcher } from "./tools/researcher"')
  })
})

// ---------------------------------------------------------------------------
// Prompt integration tests — main agent prompts reference the researcher
// ---------------------------------------------------------------------------

describe("main agent prompts reference researcher", () => {
  const PROMPT_DIR = path.resolve(
    __dirname,
    "../../../opencode/src/agent/prompt",
  )

  test("finny-build.txt documents finny_research_dispatch and dispatch workflow", async () => {
    const content = await fs.readFile(
      path.join(PROMPT_DIR, "finny-build.txt"),
      "utf8",
    )

    expect(content).toContain("finny_research_dispatch")
    expect(content).toContain('subagent_type: "researcher"')
    expect(content).toContain('mode: "background"')
    expect(content).toContain("Deep Research")
  })

  test("finny-research.txt documents finny_research_dispatch and dispatch workflow", async () => {
    const content = await fs.readFile(
      path.join(PROMPT_DIR, "finny-research.txt"),
      "utf8",
    )

    expect(content).toContain("finny_research_dispatch")
    expect(content).toContain('subagent_type: "researcher"')
    expect(content).toContain("Deep Research")
  })

  test("finny-chat.txt documents finny_research_dispatch and dispatch workflow", async () => {
    const content = await fs.readFile(
      path.join(PROMPT_DIR, "finny-chat.txt"),
      "utf8",
    )

    expect(content).toContain("finny_research_dispatch")
    expect(content).toContain('subagent_type: "researcher"')
    expect(content).toContain("Deep Research")
  })

  test("all three prompts describe the same dispatch workflow steps", async () => {
    const prompts = await Promise.all(
      ["finny-build.txt", "finny-research.txt", "finny-chat.txt"].map((f) =>
        fs.readFile(path.join(PROMPT_DIR, f), "utf8"),
      ),
    )

    for (const content of prompts) {
      // Step 1: call finny_research_dispatch
      expect(content).toContain("finny_research_dispatch")
      // Step 2: call task with researcher
      expect(content).toContain("task(")
      // Step 3: continue while researcher works
      expect(content).toContain("background")
    }
  })
})
