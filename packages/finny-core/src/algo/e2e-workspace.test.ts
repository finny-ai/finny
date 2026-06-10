/**
 * Single end-to-end test: subagents can bootstrap an algo workspace with a
 * unique slug, the workspace survives a real writeAlgo (simulating
 * finny_algorithm_save after digests land), and the active-algo marker
 * flows correctly throughout.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  algoDir,
  ensureAlgoWorkspace,
  getActiveAlgo,
  clearActiveAlgo,
  parseMission,
  writeAlgo,
  loadAlgo,
  isSlug,
  humanNameOf,
} from "./index"
import {
  DATA_NEWS_HEADLINES_DIR,
  DATA_NEWS_BODY_DIR,
  DATA_STOCK_DIR,
  DATA_CRYPTO_DIR,
  DATA_SEC_DIR,
  MISSION_FILE,
} from "./schemas"

let savedEnv: NodeJS.ProcessEnv
let sandbox: string
let root: string

beforeEach(async () => {
  savedEnv = { ...process.env }
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-e2e-ws-"))
  process.env.XDG_DATA_HOME = sandbox
  delete process.env.LOCALAPPDATA
  root = path.join(sandbox, "finny", "algos")
  await fs.mkdir(root, { recursive: true })
})

afterEach(async () => {
  process.env = savedEnv
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("subagents-without-scaffold: full lifecycle with slugs", () => {
  test("bootstrap → data write → real save → load — each workspace is unique", async () => {
    const algoName = "btc-mean-reversion-1h"

    // ─── Phase 0: no active algo, fresh session ───
    expect(await getActiveAlgo({ cwd: sandbox })).toBeNull()

    // ─── Phase 1: data extractor bootstraps workspace (first subagent call) ───
    const res1 = await ensureAlgoWorkspace(algoName, { root, setActive: true })
    expect(res1.created).toBe(true)
    expect(isSlug(res1.slug)).toBe(true)
    expect(humanNameOf(res1.slug)).toBe(algoName)
    expect(res1.dir).toBe(algoDir(res1.slug, root))
    expect(await getActiveAlgo()).toBe(res1.slug)

    // Verify full directory tree was created
    const dir = res1.dir
    for (const sub of [DATA_STOCK_DIR, DATA_CRYPTO_DIR, DATA_SEC_DIR, DATA_NEWS_HEADLINES_DIR, DATA_NEWS_BODY_DIR]) {
      const stat = await fs.stat(path.join(dir, sub))
      expect(stat.isDirectory()).toBe(true)
    }

    // Placeholder mission.md stores human name, not slug
    const placeholderRaw = await fs.readFile(path.join(dir, MISSION_FILE), "utf8")
    const placeholder = parseMission(placeholderRaw)
    expect(placeholder.frontmatter.name).toBe(algoName)
    expect(placeholder.frontmatter.status).toBe("research")

    // ─── Phase 2: researcher bootstraps same workspace via slug (idempotent) ───
    const res2 = await ensureAlgoWorkspace(res1.slug, { root })
    expect(res2.created).toBe(false)
    expect(res2.slug).toBe(res1.slug)
    const stillPlaceholder = await fs.readFile(path.join(dir, MISSION_FILE), "utf8")
    expect(stillPlaceholder).toBe(placeholderRaw)

    // ─── Phase 3: simulate subagent writing data files ───
    const parquetPath = path.join(dir, DATA_CRYPTO_DIR, "btc-usd-1h.parquet")
    await fs.writeFile(parquetPath, "fake-parquet-bytes")
    const headlinePath = path.join(dir, DATA_NEWS_HEADLINES_DIR, "2024-03-15.md")
    await fs.writeFile(headlinePath, "# BTC headlines\n- market up 3%\n")

    // ─── Phase 4: agent does the real save using the same slug ───
    const writeResult = await writeAlgo({
      root,
      slug: res1.slug,
      mission: {
        frontmatter: {
          schema_version: 2,
          name: algoName,
          status: "backtested",
          created: "2026-05-21",
          hypothesis: "Mean-reversion on BTC/USD 1h using Bollinger bands",
          scope: { asset_class: "crypto", universe: ["BTC"], horizon: "days" },
          exit_conditions: "- 7d max hold\n- 2% stop loss",
        },
        body: "\n# btc-mean-reversion-1h\n\nBuilt from price digest + news brief.\n",
      },
      current: "v01",
      versions: {
        v01: {
          strategy: "class Strategy:\n  pass\n",
          reasoning: "Price data showed X; news showed Y; combined, I designed Z.",
        },
      },
    })
    expect(writeResult.slug).toBe(res1.slug)

    // ─── Phase 5: verify the real save landed correctly ───
    const realMission = await fs.readFile(path.join(dir, MISSION_FILE), "utf8")
    expect(realMission).not.toBe(placeholderRaw)
    const parsed = parseMission(realMission)
    expect(parsed.frontmatter.status).toBe("backtested")

    // Data files survived the save
    expect(await fs.readFile(parquetPath, "utf8")).toBe("fake-parquet-bytes")
    expect(await fs.readFile(headlinePath, "utf8")).toContain("market up 3%")

    // loadAlgo works with slug
    const algo = await loadAlgo(res1.slug, root)
    expect(algo.current).toBe("v01")
    expect(algo.displayName).toBe(algoName)
    expect(algo.name).toBe(res1.slug)

    // loadAlgo also works with human name (resolves to slug dir)
    const algoByName = await loadAlgo(algoName, root)
    expect(algoByName.name).toBe(res1.slug)

    // ─── Phase 6: distinct workspaces via explicit datetime suffix ───
    // Same name in the same minute reuses the workspace (datetime slugs);
    // a second session at a different time gets its own directory.
    const res3 = await ensureAlgoWorkspace(algoName, { root, setActive: true, slug: `${algoName}.2.1.09.30` })
    expect(res3.created).toBe(true)
    expect(res3.slug).not.toBe(res1.slug)
    expect(res3.dir).not.toBe(res1.dir)
    expect(await getActiveAlgo()).toBe(res3.slug)
    // Original workspace still intact
    expect(await loadAlgo(res1.slug, root)).toBeTruthy()

    // ─── Phase 7: invalid name is rejected ───
    await expect(ensureAlgoWorkspace("Bad Name!", { root })).rejects.toThrow(/kebab-case/)

    // ─── Phase 8: clearActiveAlgo and re-bootstrap ───
    await clearActiveAlgo()
    expect(await getActiveAlgo({ cwd: sandbox })).toBeNull()
  })
})
