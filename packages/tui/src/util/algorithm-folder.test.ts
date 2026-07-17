import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AlgorithmFolderResult } from "./algorithm-folder"
import { resolveAlgorithmFolder } from "./algorithm-folder"

let sandbox: string
let algosRoot: string
let algorithmsRoot: string

interface SelectedAlgorithm {
  algorithmId: string
  name: string
}

interface WorkspaceManifestFixture {
  slug: string
  entry: { algorithmId?: string; name: string; updated?: string }
}

interface WorkspaceRequestFixture {
  slug: string
  entry: { requested_algorithm_name: string; updated?: string }
}

interface ResolveScenario {
  title: string
  selected: SelectedAlgorithm
  manifest?: WorkspaceManifestFixture
  request?: WorkspaceRequestFixture
  store?: boolean
  expected: "workspace" | "store" | "missing"
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-algorithm-folder-"))
  algosRoot = path.join(sandbox, "algos")
  algorithmsRoot = path.join(sandbox, "algorithms")
  await fs.mkdir(algosRoot, { recursive: true })
  await fs.mkdir(algorithmsRoot, { recursive: true })
})

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

function folderRequest(selected: SelectedAlgorithm) {
  return {
    ...selected,
    algosRoot,
    algorithmsRoot,
  }
}

async function createStore(selected: SelectedAlgorithm): Promise<string> {
  const store = path.join(algorithmsRoot, selected.algorithmId)
  await fs.mkdir(store, { recursive: true })
  return store
}

async function expectResolved(selected: SelectedAlgorithm, expected: AlgorithmFolderResult): Promise<void> {
  await expect(resolveAlgorithmFolder(folderRequest(selected))).resolves.toEqual(expected)
}

async function writeWorkspaceManifest(input: WorkspaceManifestFixture): Promise<string> {
  const dir = path.join(algosRoot, input.slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    JSON.stringify({ algorithms: [{ latest_version: 1, store_path: "/tmp/store", ...input.entry }] }, null, 2),
    "utf8",
  )
  return dir
}

async function writeWorkspaceRequest(input: WorkspaceRequestFixture): Promise<string> {
  const dir = path.join(algosRoot, input.slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "request.json"), JSON.stringify(input.entry, null, 2), "utf8")
  return dir
}

async function workspaceFixture(input: ResolveScenario): Promise<string | undefined> {
  const manifestDir = input.manifest ? await writeWorkspaceManifest(input.manifest) : undefined
  const requestDir = input.request ? await writeWorkspaceRequest(input.request) : undefined
  return manifestDir ?? requestDir
}

async function expectedResult(input: ResolveScenario, workspace: string | undefined): Promise<AlgorithmFolderResult> {
  if (input.expected === "missing") return { found: false }
  if (input.expected === "workspace" && workspace) return { found: true, kind: "workspace", path: workspace }
  return { found: true, kind: "store", path: await createStore(input.selected) }
}

async function runScenario(input: ResolveScenario): Promise<void> {
  const workspace = await workspaceFixture(input)
  if (input.store && input.expected !== "store") await createStore(input.selected)
  await expectResolved(input.selected, await expectedResult(input, workspace))
}

const scenarios: ResolveScenario[] = [
  {
    title: "prefers the rich workspace folder when manifest maps the algorithm id",
    selected: { algorithmId: "algo-1", name: "spy-15m-mean-reversion" },
    manifest: {
      slug: "spy-15m-mean-reversion.30.6.19.35.abcdef12",
      entry: {
        algorithmId: "algo-1",
        name: "spy-15m-mean-reversion",
        updated: "2026-06-30T23:35:00.000Z",
      },
    },
    store: true,
    expected: "workspace",
  },
  {
    title: "matches workspace manifests by algorithm name when id is absent",
    selected: { algorithmId: "algo-2", name: "btc-15m-breakout" },
    manifest: {
      slug: "btc-15m-breakout.30.6.19.40.abcdef12",
      entry: { name: "btc-15m-breakout", updated: "2026-06-30T23:40:00.000Z" },
    },
    expected: "workspace",
  },
  {
    title: "ignores stale same-name workspace manifests when ids differ",
    selected: { algorithmId: "algo-2", name: "btc-15m-breakout" },
    manifest: {
      slug: "btc-15m-breakout.30.6.19.40.abcdef12",
      entry: {
        algorithmId: "deleted-or-old-id",
        name: "btc-15m-breakout",
        updated: "2026-06-30T23:40:00.000Z",
      },
    },
    expected: "store",
  },
  {
    title: "does not use request metadata from a stale same-name saved manifest",
    selected: { algorithmId: "algo-2b", name: "spy-15m-breakout" },
    manifest: {
      slug: "spy-15m-breakout.30.6.19.40.abcdef12",
      entry: {
        algorithmId: "deleted-or-old-id",
        name: "spy-15m-breakout",
        updated: "2026-06-30T23:40:00.000Z",
      },
    },
    request: {
      slug: "spy-15m-breakout.30.6.19.40.abcdef12",
      entry: {
        requested_algorithm_name: "spy-15m-breakout",
        updated: "2026-06-30T23:41:00.000Z",
      },
    },
    expected: "store",
  },
  {
    title: "falls back to the saved algorithm store when no workspace manifest maps it",
    selected: { algorithmId: "algo-3", name: "qqq-15min-trend-pullback" },
    manifest: {
      slug: "unrelated.30.6.19.45.abcdef12",
      entry: { algorithmId: "other-id", name: "other-algo" },
    },
    expected: "store",
  },
  {
    title: "uses request metadata when a headless workspace has no saved-algorithm manifest",
    selected: { algorithmId: "algo-4", name: "qqq-15m-trend-pullback" },
    request: {
      slug: "qqq-15m-trend-pullback.30.6.19.57.abcdef12",
      entry: {
        requested_algorithm_name: "qqq-15m-trend-pullback",
        updated: "2026-06-30T23:57:00.000Z",
      },
    },
    store: true,
    expected: "workspace",
  },
  {
    title: "uses workspace slug overlap when the saved name extends the request name",
    selected: { algorithmId: "algo-5", name: "btc-15m-momentum-breakout" },
    request: {
      slug: "btc-15m-momentum.30.6.19.57.0e746493",
      entry: {
        requested_algorithm_name: "btc-15m-momentum",
        updated: "2026-06-30T23:57:00.000Z",
      },
    },
    store: true,
    expected: "workspace",
  },
  {
    title: "returns not found when neither workspace nor store folder exists",
    selected: { algorithmId: "missing-id", name: "missing-algo" },
    expected: "missing",
  },
]

describe("resolveAlgorithmFolder", () => {
  for (const scenario of scenarios) {
    test(scenario.title, async () => {
      await runScenario(scenario)
    })
  }
})
