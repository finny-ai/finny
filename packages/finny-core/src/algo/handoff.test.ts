import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildCompactionContext,
  parseMission,
  readSubagentSummaries,
  renderProgressTimeline,
  subagentKind,
  writeAlgo,
  writeProgress,
  writeSubagentSummary,
  PROGRESS_FILE,
  algoDir,
} from "./index"

const MISSION_YAML = `---
schema_version: 2
name: demo-strat
status: research
created: 2026-06-25
hypothesis: |
  Demo hypothesis.
scope:
  asset_class: equities
  universe: [AAPL]
  horizon: days
exit_conditions: |
  Stop at -2%.
---

# Demo
`

async function mkSandbox(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "finny-handoff-test-"))
}

async function seedAlgo(root: string) {
  const mission = parseMission(MISSION_YAML)
  const { slug } = await writeAlgo({
    root,
    mission,
    current: "v01",
    versions: { v01: { strategy: "class Strategy:\n    pass\n", reasoning: "# v01 reasoning\n" } },
  })
  return slug
}

describe("subagentKind", () => {
  test("maps subagent types to stable kind labels", () => {
    expect(subagentKind("data_extractor")).toBe("data")
    expect(subagentKind("news_agent")).toBe("news")
    expect(subagentKind("researcher")).toBe("news")
    expect(subagentKind("sec_agent")).toBe("sec")
    expect(subagentKind("unknown")).toBeNull()
  })
})

describe("subagent summary persistence", () => {
  test("writes and reads back summaries, latest wins, sorted by filename", async () => {
    const root = await mkSandbox()
    const slug = await seedAlgo(root)

    await writeSubagentSummary(slug, "news", "news v1", root)
    await writeSubagentSummary(slug, "data", "data findings", root)
    await writeSubagentSummary(slug, "news", "news v2 (latest)", root)

    const summaries = await readSubagentSummaries(slug, root)
    expect(summaries).toEqual([
      { kind: "data", body: "data findings" },
      { kind: "news", body: "news v2 (latest)" },
    ])
  })

  test("returns [] when the .finny dir does not exist", async () => {
    const root = await mkSandbox()
    const slug = await seedAlgo(root)
    expect(await readSubagentSummaries(slug, root)).toEqual([])
  })
})

describe("buildCompactionContext", () => {
  test("includes persisted subagent summaries", async () => {
    const root = await mkSandbox()
    const slug = await seedAlgo(root)
    await writeSubagentSummary(slug, "data", "OHLCV pulled for AAPL", root)
    await writeSubagentSummary(slug, "news", "Earnings beat", root)

    const ctx = await buildCompactionContext(slug, root)
    expect(ctx.mission).toContain("demo-strat")
    expect(ctx.current).toBe("v01")
    expect(ctx.reasoning).toBe("# v01 reasoning\n")
    expect(ctx.subagentSummaries).toEqual([
      { kind: "data", body: "OHLCV pulled for AAPL" },
      { kind: "news", body: "Earnings beat" },
    ])
  })

  test("works with no subagent summaries", async () => {
    const root = await mkSandbox()
    const slug = await seedAlgo(root)
    const ctx = await buildCompactionContext(slug, root)
    expect(ctx.subagentSummaries).toEqual([])
  })

  test("tolerates a pre-v1 workspace (no CURRENT) and still returns subagent summaries", async () => {
    const root = await mkSandbox()
    // Simulate an early workspace: placeholder mission.md, no CURRENT/version yet.
    const dir = path.join(root, "early-strat")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "mission.md"), "# placeholder mission\n", "utf8")
    await writeSubagentSummary("early-strat", "data", "AAPL OHLCV ready", root)

    const ctx = await buildCompactionContext("early-strat", root)
    expect(ctx.current).toBeNull()
    expect(ctx.reasoning).toBeNull()
    expect(ctx.mission).toContain("placeholder mission")
    expect(ctx.subagentSummaries).toEqual([{ kind: "data", body: "AAPL OHLCV ready" }])
  })
})

describe("progress timeline", () => {
  test("renderProgressTimeline formats ordered steps", () => {
    const out = renderProgressTimeline({
      algo: "demo-strat",
      version: "v02",
      steps: ["Asked: \"build a momentum strat\"", "Launched data_extractor subagent", "Saved strategy v01"],
      date: "2026-06-25",
    })
    expect(out).toContain("# Progress — demo-strat")
    expect(out).toContain("current version v02")
    expect(out).toContain("- Launched data_extractor subagent")
    expect(out).toContain("- Saved strategy v01")
  })

  test("renderProgressTimeline handles empty steps", () => {
    const out = renderProgressTimeline({ algo: "demo-strat", version: "v01", steps: [], date: "2026-06-25" })
    expect(out).toContain("(no recorded steps yet)")
  })

  test("writeProgress overwrites progress.md", async () => {
    const root = await mkSandbox()
    const slug = await seedAlgo(root)
    await writeProgress(slug, "first", root)
    await writeProgress(slug, "second", root)
    const body = await fs.readFile(path.join(algoDir(slug, root), PROGRESS_FILE), "utf8")
    expect(body.trim()).toBe("second")
  })
})
