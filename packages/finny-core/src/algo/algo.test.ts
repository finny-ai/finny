import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  Backtest,
  DATA_NEWS_BODY_DIR,
  DATA_NEWS_HEADLINES_DIR,
  DATA_STOCK_DIR,
  MEMORY_FILE,
  MissionFrontmatter,
  algoDir,
  algosRoot,
  discoverAlgos,
  discoverVersions,
  humanNameOf,
  isSlug,
  listAlgos,
  loadAlgo,
  parseCurrent,
  parseMission,
  serializeMission,
  writeAlgo,
} from "./index"

const EXAMPLE_MISSION_YAML = `---
schema_version: 3
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
strategy:
  bar_interval: 1h
  type: event-driven-swing
  direction: long
  entry_signal: biotech sympathy breakout after outbreak news
  risk_profile: moderate
  max_drawdown_pct: "12"
  backtest_window: 2014-2024 analog events
  success_metric: Sharpe above 1 with max drawdown below 12%
exit_conditions: |
  - Time stop: 10 trading days from entry
  - Price stop: -8% from entry
  - Thesis stop: WHO downgrades risk OR no follow-on news for 5 days
questionnaire:
  - id: market_universe
    question: "Which market or universe should this strategy trade?"
    answer: "MRNA, GILD, SIGA, PFE"
    status: answered
  - id: timeframe_bar_interval
    question: "What trading timeframe and bar interval should this strategy use?"
    answer: "Swing trading on 1h bars"
    status: answered
  - id: strategy_family
    question: "What strategy family should Finny start from?"
    answer: "Event-driven swing"
    status: answered
  - id: directional_thesis_regime
    question: "What directional thesis or market regime should the strategy express?"
    answer: "Long biotech sympathy after outbreak news"
    status: answered
  - id: entry_signal_idea
    question: "What entry signal idea should the strategy test?"
    answer: "Breakout after outbreak-related catalyst"
    status: answered
  - id: exit_invalidation_rules
    question: "What exit or invalidation rules matter?"
    answer: "Time stop, price stop, and thesis downgrade"
    status: answered
  - id: risk_tolerance_max_drawdown
    question: "What risk tolerance and maximum drawdown should the strategy respect?"
    answer: "Moderate risk, max 12% drawdown"
    status: answered
  - id: backtest_window_success_metric
    question: "What backtest window and success metric should Finny optimize for?"
    answer: "2014-2024 analog events, Sharpe above 1 with drawdown below 12%"
    status: answered
---

# Hanta-driven biotech swing

Rationale body.
`

const EXAMPLE_BACKTEST = {
  schema_version: 2 as const,
  version: "v02",
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

const EXAMPLE_STRATEGY = {
  bar_interval: "1h",
  type: "event-driven-swing",
  direction: "long",
  entry_signal: "biotech sympathy breakout after outbreak news",
  risk_profile: "moderate",
  max_drawdown_pct: "12",
  backtest_window: "2014-2024 analog events",
  success_metric: "Sharpe above 1 with max drawdown below 12%",
}

const EXAMPLE_QUESTIONNAIRE = [
  {
    id: "market_universe",
    question: "Which market or universe should this strategy trade?",
    answer: "MRNA, GILD, SIGA, PFE",
    status: "answered",
  },
  {
    id: "timeframe_bar_interval",
    question: "What trading timeframe and bar interval should this strategy use?",
    answer: "Swing trading on 1h bars",
    status: "answered",
  },
  {
    id: "strategy_family",
    question: "What strategy family should Finny start from?",
    answer: "Event-driven swing",
    status: "answered",
  },
  {
    id: "directional_thesis_regime",
    question: "What directional thesis or market regime should the strategy express?",
    answer: "Long biotech sympathy after outbreak news",
    status: "answered",
  },
  {
    id: "entry_signal_idea",
    question: "What entry signal idea should the strategy test?",
    answer: "Breakout after outbreak-related catalyst",
    status: "answered",
  },
  {
    id: "exit_invalidation_rules",
    question: "What exit or invalidation rules matter?",
    answer: "Time stop, price stop, and thesis downgrade",
    status: "answered",
  },
  {
    id: "risk_tolerance_max_drawdown",
    question: "What risk tolerance and maximum drawdown should the strategy respect?",
    answer: "Moderate risk, max 12% drawdown",
    status: "answered",
  },
  {
    id: "backtest_window_success_metric",
    question: "What backtest window and success metric should Finny optimize for?",
    answer: "2014-2024 analog events, Sharpe above 1 with drawdown below 12%",
    status: "answered",
  },
] as const

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
      schema_version: 3,
      name: "ok-name",
      status: "yolo",
      created: "2026-05-10",
      hypothesis: "x",
      scope: { asset_class: "equities", universe: ["X"], horizon: "days" },
      strategy: EXAMPLE_STRATEGY,
      exit_conditions: "x",
      questionnaire: EXAMPLE_QUESTIONNAIRE,
    }
    expect(() => MissionFrontmatter.parse(bad)).toThrow()
  })

  test("rejects non-kebab-case names", () => {
    const bad = {
      schema_version: 3,
      name: "Hanta_Biotech",
      status: "research",
      created: "2026-05-10",
      hypothesis: "x",
      scope: { asset_class: "equities", universe: ["X"], horizon: "days" },
      strategy: EXAMPLE_STRATEGY,
      exit_conditions: "x",
      questionnaire: EXAMPLE_QUESTIONNAIRE,
    }
    expect(() => MissionFrontmatter.parse(bad)).toThrow()
  })

  test("rejects missing questionnaire records", () => {
    const bad = {
      schema_version: 3,
      name: "ok-name",
      status: "research",
      created: "2026-05-10",
      hypothesis: "x",
      scope: { asset_class: "equities", universe: ["X"], horizon: "days" },
      strategy: EXAMPLE_STRATEGY,
      exit_conditions: "x",
      questionnaire: EXAMPLE_QUESTIONNAIRE.slice(0, 7),
    }
    expect(() => MissionFrontmatter.parse(bad)).toThrow()
  })

  test("allows blank strategy fields only when the linked question was skipped", () => {
    const questionnaire = EXAMPLE_QUESTIONNAIRE.map((item) =>
      item.id === "timeframe_bar_interval" ? { ...item, answer: "", status: "skipped" } : item,
    )
    expect(() =>
      MissionFrontmatter.parse({
        schema_version: 3,
        name: "ok-name",
        status: "research",
        created: "2026-05-10",
        hypothesis: "x",
        scope: { asset_class: "equities", universe: ["X"], horizon: "days" },
        strategy: { ...EXAMPLE_STRATEGY, bar_interval: "" },
        exit_conditions: "x",
        questionnaire,
      }),
    ).not.toThrow()

    expect(() =>
      MissionFrontmatter.parse({
        schema_version: 3,
        name: "ok-name",
        status: "research",
        created: "2026-05-10",
        hypothesis: "x",
        scope: { asset_class: "equities", universe: ["X"], horizon: "days" },
        strategy: { ...EXAMPLE_STRATEGY, type: "" },
        exit_conditions: "x",
        questionnaire: EXAMPLE_QUESTIONNAIRE,
      }),
    ).toThrow()
  })

  test("rejects schema_version 2 (must migrate)", () => {
    const oldVersion = {
      schema_version: 2,
      name: "ok-name",
      status: "research",
      created: "2026-05-10",
      hypothesis: "x",
      scope: { asset_class: "equities", universe: ["X"], horizon: "days" },
      exit_conditions: "x",
    }
    expect(() => MissionFrontmatter.parse(oldVersion)).toThrow()
  })
})

describe("Backtest schema", () => {
  test("accepts the example payload", () => {
    const parsed = Backtest.parse(EXAMPLE_BACKTEST)
    expect(parsed.metrics.ann_sharpe).toBe(1.4)
    expect(parsed.version).toBe("v02")
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

  test("rejects unpadded version names", () => {
    const bad = structuredClone(EXAMPLE_BACKTEST) as any
    bad.version = "v2"
    expect(() => Backtest.parse(bad)).toThrow()
  })
})

describe("parseCurrent", () => {
  test("accepts v01 / v17 with trailing newline", () => {
    expect(parseCurrent("v01\n")).toBe("v01")
    expect(parseCurrent("  v17  ")).toBe("v17")
  })

  test("rejects v0, v00, unpadded v1, garbage, and empty", () => {
    expect(() => parseCurrent("v0")).toThrow()
    expect(() => parseCurrent("v00")).toThrow()
    expect(() => parseCurrent("v1")).toThrow()
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

    const v02Strategy = "# v02 strategy code\nclass Strategy:\n    pass\n"
    const v01Strategy = "# v01 strategy code\nclass Strategy:\n    pass\n"

    const { slug } = await writeAlgo({
      root,
      mission,
      current: "v02",
      decisions: "# Decisions log: hanta-biotech-swing\n\n2026-05-10: scoped universe\n",
      prefs: "# Preferences: hanta-biotech-swing\n",
      versions: {
        v01: { strategy: v01Strategy, reasoning: "# v01 reasoning\n" },
        v02: { strategy: v02Strategy, reasoning: "# v02 reasoning\n", backtest: EXAMPLE_BACKTEST as any },
      },
    })

    expect(isSlug(slug)).toBe(true)
    expect(humanNameOf(slug)).toBe("hanta-biotech-swing")

    const algo = await loadAlgo("hanta-biotech-swing", root)
    expect(algo.current).toBe("v02")
    expect(algo.versions).toEqual(["v01", "v02"])
    expect(algo.mission.frontmatter.name).toBe("hanta-biotech-swing")
    expect(algo.name).toBe(slug)
    expect(algo.displayName).toBe("hanta-biotech-swing")
    expect(algo.dir).toBe(algoDir(slug, root))

    const decisions = await algo.decisions()
    expect(decisions).toContain("2026-05-10")

    const memory = await algo.memory()
    expect(memory).toContain("Memory: hanta-biotech-swing")

    const current = algo.version()
    expect(current.name).toBe("v02")
    expect(await current.strategy()).toBe(v02Strategy)
    const bt = await current.backtest()
    expect(bt?.metrics.ann_sharpe).toBe(1.4)

    const v01 = algo.version("v01")
    expect(await v01.strategy()).toBe(v01Strategy)
    expect(await v01.backtest()).toBeNull()
    expect(await v01.reasoning()).toBe("# v01 reasoning\n")

    const headers = await listAlgos(root)
    expect(headers).toHaveLength(1)
    expect(isSlug(headers[0]!.name)).toBe(true)
    expect(headers[0]!.displayName).toBe("hanta-biotech-swing")
    expect(headers[0]!.current).toBe("v02")
    expect(headers[0]!.mission.frontmatter.status).toBe("research")
  })

  test("writeAlgo creates the data/ skeleton", async () => {
    const root = await mkSandbox()
    const mission = parseMission(EXAMPLE_MISSION_YAML)
    const { dir, slug } = await writeAlgo({
      root,
      mission,
      current: "v01",
      versions: { v01: { strategy: "class Strategy: pass\n" } },
    })
    expect(dir).toBe(algoDir(slug, root))
    for (const sub of [DATA_STOCK_DIR, DATA_NEWS_HEADLINES_DIR, DATA_NEWS_BODY_DIR]) {
      const stat = await fs.stat(path.join(dir, sub))
      expect(stat.isDirectory()).toBe(true)
    }
    const memorySeed = await fs.readFile(path.join(dir, MEMORY_FILE), "utf8")
    expect(memorySeed).toContain("Memory: hanta-biotech-swing")
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
    const { slug } = await writeAlgo({
      root,
      mission,
      current: "v01",
      versions: {
        v01: { strategy: "class Strategy: pass\n", backtest: { ...EXAMPLE_BACKTEST, version: "v01" } as any, reasoning: "# v01\n" },
      },
    })

    const algo = await loadAlgo(slug, root)
    expect(algo.mission.frontmatter).toEqual(mission.frontmatter)
    const bt = await algo.version("v01").backtest()
    expect(bt).toEqual(Backtest.parse({ ...EXAMPLE_BACKTEST, version: "v01" }))
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
  test("returns lexicographic-sorted padded version dirs only", async () => {
    const root = await mkSandbox()
    const dir = path.join(root, "x-algo")
    await fs.mkdir(path.join(dir, "v01"), { recursive: true })
    await fs.mkdir(path.join(dir, "v10"), { recursive: true })
    await fs.mkdir(path.join(dir, "v02"), { recursive: true })
    await fs.mkdir(path.join(dir, ".archive"), { recursive: true })
    await fs.mkdir(path.join(dir, "v1"), { recursive: true }) // unpadded, ignored
    await fs.writeFile(path.join(dir, "mission.md"), "stub")
    expect(await discoverVersions("x-algo", root)).toEqual(["v01", "v02", "v10"])
  })
})
