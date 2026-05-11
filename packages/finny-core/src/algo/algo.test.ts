import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  Backtest,
  MissionFrontmatter,
  algoDir,
  algosRoot,
  discoverAlgos,
  discoverVersions,
  listAlgos,
  loadAlgo,
  parseCurrent,
  parseMission,
  serializeMission,
  writeAlgo,
} from "./index"

const EXAMPLE_MISSION_YAML = `---
schema_version: 1
name: hanta-biotech-swing
status: research
created: 2026-05-10
hypothesis: |
  Recent hantavirus outbreak (Andes strain, MV Hondius cruise ship) drives
  attention to antiviral biotechs. Pattern: novel infectious-disease news →
  multi-day drift in pure-play antiviral names.
scope:
  asset_class: equities
  universe: [MRNA, GILD, SIGA, PFE]
  horizon: days
exit_conditions: |
  - Time stop: 10 trading days from entry
  - Price stop: -8% from entry
  - Thesis stop: WHO downgrades risk OR no follow-on news for 5 days
---

# Hanta-driven biotech swing

Rationale body.
`

const EXAMPLE_BACKTEST = {
  schema_version: 1 as const,
  version: "v2",
  ran_at: "2026-05-10T12:34:56Z",
  period: { start: "2024-01-01", end: "2026-05-09", interval: "1h", bars: 8400 },
  config: { starting_cash: 1000, symbols: ["MRNA", "GILD", "SIGA", "PFE"] },
  metrics: {
    total_return: 0.34,
    ann_sharpe: 1.4,
    annualized_volatility: 0.22,
    max_drawdown: -0.12,
    win_rate: 0.52,
    profit_factor: 1.8,
    ending_equity: 1340.5,
    total_trades: 87,
  },
  notes: "Pattern-backtest using analogous virus-news events 2014-2024",
}

async function mkSandbox(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "finny-algo-test-"))
}

describe("MissionFrontmatter schema", () => {
  test("accepts the example payload", () => {
    const { frontmatter } = parseMission(EXAMPLE_MISSION_YAML)
    expect(frontmatter.name).toBe("hanta-biotech-swing")
    expect(frontmatter.status).toBe("research")
    expect(frontmatter.scope.universe).toEqual(["MRNA", "GILD", "SIGA", "PFE"])
  })

  test("rejects malformed frontmatter (bad status enum)", () => {
    const bad = {
      schema_version: 1,
      name: "ok-name",
      status: "yolo",
      created: "2026-05-10",
      hypothesis: "x",
      scope: { asset_class: "equities", universe: ["X"], horizon: "days" },
      exit_conditions: "x",
    }
    expect(() => MissionFrontmatter.parse(bad)).toThrow()
  })

  test("rejects non-kebab-case names", () => {
    const bad = {
      schema_version: 1,
      name: "Hanta_Biotech",
      status: "research",
      created: "2026-05-10",
      hypothesis: "x",
      scope: { asset_class: "equities", universe: ["X"], horizon: "days" },
      exit_conditions: "x",
    }
    expect(() => MissionFrontmatter.parse(bad)).toThrow()
  })
})

describe("Backtest schema", () => {
  test("accepts the example payload", () => {
    const parsed = Backtest.parse(EXAMPLE_BACKTEST)
    expect(parsed.metrics.ann_sharpe).toBe(1.4)
    expect(parsed.version).toBe("v2")
  })

  test("rejects payload missing a required metric field", () => {
    const bad = structuredClone(EXAMPLE_BACKTEST) as any
    delete bad.metrics.win_rate
    expect(() => Backtest.parse(bad)).toThrow()
  })

  test("accepts null for genuinely unmeasurable metrics", () => {
    const ok = structuredClone(EXAMPLE_BACKTEST) as any
    ok.metrics.profit_factor = null
    ok.metrics.total_trades = 0
    expect(() => Backtest.parse(ok)).not.toThrow()
  })
})

describe("parseCurrent", () => {
  test("accepts v1 / v17 with trailing newline", () => {
    expect(parseCurrent("v1\n")).toBe("v1")
    expect(parseCurrent("  v17  ")).toBe("v17")
  })

  test("rejects v0, garbage, and empty", () => {
    expect(() => parseCurrent("v0")).toThrow()
    expect(() => parseCurrent("latest")).toThrow()
    expect(() => parseCurrent("")).toThrow()
  })
})

describe("algosRoot", () => {
  test("respects XDG_DATA_HOME on linux/darwin", () => {
    const got = algosRoot({ XDG_DATA_HOME: "/x/data" } as any, "darwin")
    expect(got).toBe(path.join("/x/data", "finny", "algos"))
  })

  test("falls back to ~/.local/share on linux/darwin without XDG", () => {
    const got = algosRoot({} as any, "linux")
    expect(got.endsWith(path.join(".local", "share", "finny", "algos"))).toBe(true)
  })

  test("uses %LOCALAPPDATA% on win32", () => {
    const got = algosRoot({ LOCALAPPDATA: "C:\\\\users\\\\me\\\\AppData\\\\Local" } as any, "win32")
    expect(got).toBe(path.join("C:\\\\users\\\\me\\\\AppData\\\\Local", "finny", "algos"))
  })

  test("falls back under AppData\\Local on win32 without LOCALAPPDATA", () => {
    const got = algosRoot({} as any, "win32")
    expect(got.includes(path.join("AppData", "Local", "finny", "algos"))).toBe(true)
  })
})

describe("loadAlgo + listAlgos", () => {
  test("loads a populated fixture and exposes lazy version accessors", async () => {
    const root = await mkSandbox()
    const mission = parseMission(EXAMPLE_MISSION_YAML)

    const v2Strategy = "# v2 strategy code\nclass Strategy:\n    pass\n"
    const v1Strategy = "# v1 strategy code\nclass Strategy:\n    pass\n"

    await writeAlgo({
      root,
      mission,
      current: "v2",
      decisions: "# Decisions log: hanta-biotech-swing\n\n2026-05-10: scoped universe\n",
      prefs: "# Preferences: hanta-biotech-swing\n",
      versions: {
        v1: { strategy: v1Strategy, notes: "# v1 notes\n" },
        v2: { strategy: v2Strategy, notes: "# v2 notes\n", backtest: EXAMPLE_BACKTEST as any },
      },
    })

    const algo = await loadAlgo("hanta-biotech-swing", root)
    expect(algo.current).toBe("v2")
    expect(algo.versions).toEqual(["v1", "v2"])
    expect(algo.mission.frontmatter.name).toBe("hanta-biotech-swing")
    expect(algo.dir).toBe(algoDir("hanta-biotech-swing", root))

    const decisions = await algo.decisions()
    expect(decisions).toContain("2026-05-10")

    const current = algo.version()
    expect(current.name).toBe("v2")
    expect(await current.strategy()).toBe(v2Strategy)
    const bt = await current.backtest()
    expect(bt?.metrics.ann_sharpe).toBe(1.4)

    const v1 = algo.version("v1")
    expect(await v1.strategy()).toBe(v1Strategy)
    expect(await v1.backtest()).toBeNull()

    const headers = await listAlgos(root)
    expect(headers).toHaveLength(1)
    expect(headers[0]!.name).toBe("hanta-biotech-swing")
    expect(headers[0]!.current).toBe("v2")
    expect(headers[0]!.mission.frontmatter.status).toBe("research")
  })

  test("discoverAlgos skips _template and dotfiles", async () => {
    const root = await mkSandbox()
    await fs.mkdir(path.join(root, "_template"), { recursive: true })
    await fs.mkdir(path.join(root, ".git"), { recursive: true })
    await fs.mkdir(path.join(root, "real-algo"), { recursive: true })
    const names = await discoverAlgos(root)
    expect(names).toEqual(["real-algo"])
  })

  test("round-trips a populated algo through writeAlgo -> loadAlgo", async () => {
    const root = await mkSandbox()
    const mission = parseMission(EXAMPLE_MISSION_YAML)
    await writeAlgo({
      root,
      mission,
      current: "v1",
      versions: {
        v1: { strategy: "class Strategy: pass\n", backtest: EXAMPLE_BACKTEST as any, notes: "# v1\n" },
      },
    })

    const algo = await loadAlgo("hanta-biotech-swing", root)
    expect(algo.mission.frontmatter).toEqual(mission.frontmatter)
    const bt = await algo.version("v1").backtest()
    expect(bt).toEqual(Backtest.parse(EXAMPLE_BACKTEST))
  })
})

describe("serializeMission", () => {
  test("round-trips frontmatter through parse -> serialize -> parse", () => {
    const parsed = parseMission(EXAMPLE_MISSION_YAML)
    const raw = serializeMission(parsed)
    const reparsed = parseMission(raw)
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter)
  })
})

describe("discoverVersions", () => {
  test("returns numeric-sorted version dirs only", async () => {
    const root = await mkSandbox()
    const dir = path.join(root, "x-algo")
    await fs.mkdir(path.join(dir, "v1"), { recursive: true })
    await fs.mkdir(path.join(dir, "v10"), { recursive: true })
    await fs.mkdir(path.join(dir, "v2"), { recursive: true })
    await fs.mkdir(path.join(dir, ".archive"), { recursive: true })
    await fs.writeFile(path.join(dir, "mission.md"), "stub")
    expect(await discoverVersions("x-algo", root)).toEqual(["v1", "v2", "v10"])
  })
})
