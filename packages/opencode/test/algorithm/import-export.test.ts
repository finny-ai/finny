import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  ZipReader,
  ZipWriter,
  BlobReader,
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  configure,
} from "@zip.js/zip.js"
import { Algorithm } from "../../src/algorithm"
import {
  ALGORITHM_BUNDLE_MANIFEST,
  exportAlgorithmBundle,
  importAlgorithmBundle,
} from "../../src/algorithm/import-export"
import { DeviceProfile } from "../../src/device"
import { LocalAlgorithmStore, algorithmsDir, type AlgorithmRow } from "../../src/storage/local/algorithm-store"

const ZIP_OPTIONS = { useWebWorkers: false } as const
configure(ZIP_OPTIONS)

let sandbox: string
let savedEnv: NodeJS.ProcessEnv

const LEGACY_MISSION = `---
schema_version: 2
name: eth-daily-momentum
status: research
created: 2026-06-30
hypothesis: Trade ETH momentum.
scope:
  asset_class: crypto
  universe: [ETH]
  horizon: days
exit_conditions: Exit when momentum reverses.
---

# ETH daily momentum
`

beforeEach(async () => {
  savedEnv = { ...process.env }
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-algo-bundle-"))
})

afterEach(async () => {
  process.env = savedEnv
  await fs.rm(sandbox, { recursive: true, force: true })
})

async function seedSourceAlgorithm(home: string): Promise<{ latest: AlgorithmRow; workspace: string }> {
  process.env.FINNY_HOME = home
  const algorithmId = "source-algo"
  const name = "eth-daily-momentum"
  await LocalAlgorithmStore.insertVersion({
    algorithmId,
    userId: "source-user",
    name,
    code: "class Strategy:\n    version = 1\n",
    language: "python",
    status: "draft",
    description: "first draft",
    config: JSON.stringify({ version: 1, risk: 0.01 }, null, 2),
    backtestCode: "print('backtest v1')\n",
    reasoning: "v1 reasoning\n",
    mission: LEGACY_MISSION,
    prefs: "Use daily bars.\n",
    decisions: "Keep drawdown capped.\n",
    time_created: 10,
    time_updated: 20,
  })
  const latest = await LocalAlgorithmStore.insertVersion({
    algorithmId,
    userId: "source-user",
    name,
    code: "class Strategy:\n    version = 2\n",
    language: "python",
    status: "draft",
    description: "second draft",
    config: JSON.stringify({ version: 2, risk: 0.02 }, null, 2),
    backtestCode: "print('backtest v2')\n",
    reasoning: "v2 reasoning\n",
    time_created: 10,
    time_updated: 30,
  })

  const workspace = path.join(home, "algos", name)
  await fs.mkdir(path.join(workspace, "data"), { recursive: true })
  await fs.mkdir(path.join(workspace, ".venv", "bin"), { recursive: true })
  await fs.symlink("/usr/bin/python3", path.join(workspace, ".venv", "bin", "python"))
  await fs.writeFile(path.join(workspace, "notes.md"), "workspace docs\n", "utf8")
  await fs.writeFile(
    path.join(workspace, "request.json"),
    JSON.stringify({ requested_algorithm_name: name, updated: "2026-06-30T00:00:00.000Z" }, null, 2),
    "utf8",
  )
  await fs.writeFile(
    path.join(workspace, "manifest.json"),
    JSON.stringify(
      {
        algorithms: [
          {
            name,
            algorithmId,
            latest_version: latest.version,
            store_path: LocalAlgorithmStore.directoryFor(algorithmId),
            updated: "2026-06-30T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  )

  return { latest, workspace }
}

async function zipEntryNames(zipPath: string): Promise<string[]> {
  const reader = new ZipReader(
    new BlobReader(new Blob([new Uint8Array(await fs.readFile(zipPath))])),
    ZIP_OPTIONS,
  )
  try {
    const entries = await reader.getEntries()
    return entries.map((entry) => entry.filename).sort()
  } finally {
    await reader.close()
  }
}

async function bundleManifest(zipPath: string): Promise<any> {
  const reader = new ZipReader(
    new BlobReader(new Blob([new Uint8Array(await fs.readFile(zipPath))])),
    ZIP_OPTIONS,
  )
  try {
    const entries = await reader.getEntries()
    const entry = entries.find((candidate) => candidate.filename === ALGORITHM_BUNDLE_MANIFEST)
    if (!entry?.getData) throw new Error("missing bundle manifest")
    const data = await entry.getData(new Uint8ArrayWriter(), ZIP_OPTIONS)
    return JSON.parse(Buffer.from(data).toString("utf8"))
  } finally {
    await reader.close()
  }
}

async function writeNonBundleZip(zipPath: string): Promise<void> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add("README.txt", new TextReader("not a Finny algorithm bundle"), ZIP_OPTIONS)
  const blob = await writer.close()
  await fs.writeFile(zipPath, new Uint8Array(await blob.arrayBuffer()))
}

async function writeZipWithEntry(zipPath: string, entryName: string): Promise<void> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add(entryName, new TextReader("bad entry"), ZIP_OPTIONS)
  const blob = await writer.close()
  await fs.writeFile(zipPath, new Uint8Array(await blob.arrayBuffer()))
}

async function addDirectoryToZip(writer: ZipWriter<Blob>, sourceDir: string, zipRoot: string): Promise<void> {
  const root = path.resolve(sourceDir)

  async function visit(dir: string): Promise<void> {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const rel = path.relative(root, fullPath).split(path.sep).join("/")
      const zipName = `${zipRoot}/${rel}`
      if (entry.isDirectory()) {
        await writer.add(`${zipName}/`, undefined, { directory: true, ...ZIP_OPTIONS })
        await visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      await writer.add(zipName, new Uint8ArrayReader(await fs.readFile(fullPath)), ZIP_OPTIONS)
    }
  }

  await visit(root)
}

async function writeBundleWithUnsafeWorkspaceBasename(zipPath: string, latest: AlgorithmRow): Promise<void> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add(
    ALGORITHM_BUNDLE_MANIFEST,
    new TextReader(
      JSON.stringify({
        schema: "finny.algorithm.bundle",
        schemaVersion: 1,
        exportedAt: "2026-07-01T00:00:00.000Z",
        source: {
          algorithmId: latest.algorithmId,
          name: latest.name,
          version: latest.version,
        },
        openFolder: {
          kind: "workspace",
          basename: "../../../../etc",
        },
      }),
    ),
    ZIP_OPTIONS,
  )
  await addDirectoryToZip(
    writer,
    LocalAlgorithmStore.directoryFor(latest.algorithmId),
    `algorithm-store/${latest.algorithmId}`,
  )
  const blob = await writer.close()
  await fs.writeFile(zipPath, new Uint8Array(await blob.arrayBuffer()))
}

async function writeLegacyV1Bundle(zipPath: string, latest: AlgorithmRow, workspace: string): Promise<void> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add(
    ALGORITHM_BUNDLE_MANIFEST,
    new TextReader(
      JSON.stringify({
        schema: "finny.algorithm.bundle",
        schemaVersion: 1,
        exportedAt: "2026-07-01T00:00:00.000Z",
        source: { algorithmId: latest.algorithmId, name: latest.name, version: latest.version },
        openFolder: { kind: "workspace", basename: path.basename(workspace) },
      }),
    ),
    ZIP_OPTIONS,
  )
  await addDirectoryToZip(writer, workspace, `open-folder/${path.basename(workspace)}`)
  await addDirectoryToZip(
    writer,
    LocalAlgorithmStore.directoryFor(latest.algorithmId),
    `algorithm-store/${latest.algorithmId}`,
  )
  const blob = await writer.close()
  await fs.writeFile(zipPath, new Uint8Array(await blob.arrayBuffer()))
}

async function expectRejectedImportWithoutWrites(input: { zipPath: string; expectedMessage: string }): Promise<void> {
  const destHome = path.join(sandbox, "dest-home")
  process.env.FINNY_HOME = destHome

  await expect(importAlgorithmBundle(input.zipPath, { conflictPolicy: "copy" })).rejects.toThrow(input.expectedMessage)
  const entries = await fs.readdir(algorithmsDir()).catch(() => [])
  expect(entries).toEqual([])
}

describe("algorithm import/export bundles", () => {
  test("export includes open-folder and algorithm-store contents", async () => {
    const sourceHome = path.join(sandbox, "source-home")
    const { latest } = await seedSourceAlgorithm(sourceHome)
    const zipPath = path.join(sandbox, "eth-daily-momentum.zip")

    await exportAlgorithmBundle(latest as Algorithm.Info, zipPath)

    const entries = await zipEntryNames(zipPath)
    expect(entries).toContain(ALGORITHM_BUNDLE_MANIFEST)
    expect(entries).toContain("open-folder/eth-daily-momentum/manifest.json")
    expect(entries).toContain("open-folder/eth-daily-momentum/request.json")
    expect(entries).toContain("open-folder/eth-daily-momentum/notes.md")
    expect(entries).not.toContain("open-folder/eth-daily-momentum/.venv/bin/python")
    expect(entries).toContain("algorithm-store/source-algo/meta.json")
    expect(entries).toContain("algorithm-store/source-algo/CURRENT")
    expect(entries).toContain("algorithm-store/source-algo/mission.md")
    expect(entries).toContain("algorithm-store/source-algo/v01/strategy.py")
    expect(entries).toContain("algorithm-store/source-algo/v02/strategy.py")
    expect(entries).toContain("algorithm-store/source-algo/v02/config.json")
    expect(await bundleManifest(zipPath)).toMatchObject({
      schemaVersion: 2,
      artifactContract: {
        missionSchemaVersion: 3,
        backtestEngine: "strict_v2",
        legacyUnsafeCustomRunner: true,
      },
    })
  })

  test("import into an empty FINNY_HOME appears in Algorithm.list and preserves versions", async () => {
    const sourceHome = path.join(sandbox, "source-home")
    const { latest } = await seedSourceAlgorithm(sourceHome)
    const zipPath = path.join(sandbox, "eth-daily-momentum.zip")
    await exportAlgorithmBundle(latest as Algorithm.Info, zipPath)

    const destHome = path.join(sandbox, "dest-home")
    process.env.FINNY_HOME = destHome
    const imported = await importAlgorithmBundle(zipPath, { conflictPolicy: "copy" })

    expect(imported.algorithm.algorithmId).not.toBe(latest.algorithmId)
    expect(imported.algorithm.name).toBe("eth-daily-momentum-imported")
    const listed = await Algorithm.list()
    expect(listed.map((algo) => algo.algorithmId)).toContain(imported.algorithm.algorithmId)

    const importedStore = LocalAlgorithmStore.directoryFor(imported.algorithm.algorithmId)
    expect(await fs.readFile(path.join(importedStore, "CURRENT"), "utf8")).toBe("v02")
    expect(await fs.readFile(path.join(importedStore, "v01", "strategy.py"), "utf8")).toContain("version = 1")
    expect(await fs.readFile(path.join(importedStore, "v02", "strategy.py"), "utf8")).toContain("version = 2")
    expect(await fs.readFile(path.join(importedStore, "v02", "config.json"), "utf8")).toContain('"version": 2')
    const importedMission = await fs.readFile(path.join(importedStore, "mission.md"), "utf8")
    expect(importedMission).toContain("schema_version: 3")
    expect(importedMission).toContain("Artifact Migration Provenance")
    expect(imported.provenance).toEqual({
      sourceBundleSchemaVersion: 2,
      missionMigration: "none",
      legacyUnsafeCustomRunner: true,
    })

    expect(imported.copiedWorkspacePath).toBe(path.join(destHome, "algos", "eth-daily-momentum-imported"))
    expect(await fs.readFile(path.join(imported.copiedWorkspacePath!, "notes.md"), "utf8")).toBe("workspace docs\n")
    const workspaceManifest = JSON.parse(
      await fs.readFile(path.join(imported.copiedWorkspacePath!, "manifest.json"), "utf8"),
    )
    expect(workspaceManifest.algorithms[0].algorithmId).toBe(imported.algorithm.algorithmId)
    expect(workspaceManifest.algorithms[0].name).toBe(imported.algorithm.name)
    expect(workspaceManifest.algorithms[0].latest_version).toBe(2)
    expect(workspaceManifest.algorithms[0].store_path).toBe(importedStore)
  })

  test("imports legacy v1 bundles through explicit v2-to-v3 mission migration", async () => {
    const sourceHome = path.join(sandbox, "source-home")
    const { latest, workspace } = await seedSourceAlgorithm(sourceHome)
    const zipPath = path.join(sandbox, "legacy-v1.zip")
    await writeLegacyV1Bundle(zipPath, latest, workspace)

    process.env.FINNY_HOME = path.join(sandbox, "dest-home")
    const imported = await importAlgorithmBundle(zipPath, { conflictPolicy: "copy" })

    expect(imported.provenance).toEqual({
      sourceBundleSchemaVersion: 1,
      missionMigration: "v2_to_v3",
      legacyUnsafeCustomRunner: true,
    })
    const mission = await fs.readFile(
      path.join(LocalAlgorithmStore.directoryFor(imported.algorithm.algorithmId), "mission.md"),
      "utf8",
    )
    expect(mission).toContain("schema_version: 3")
    expect(mission).toContain("finny.algorithm.bundle.v1")
  })

  test("import name conflict creates a numbered copy instead of overwriting", async () => {
    const sourceHome = path.join(sandbox, "source-home")
    const { latest } = await seedSourceAlgorithm(sourceHome)
    const zipPath = path.join(sandbox, "eth-daily-momentum.zip")
    await exportAlgorithmBundle(latest as Algorithm.Info, zipPath)

    const destHome = path.join(sandbox, "dest-home")
    process.env.FINNY_HOME = destHome
    const userId = await DeviceProfile.userId()
    const existing = await LocalAlgorithmStore.insertVersion({
      algorithmId: "existing-imported",
      userId,
      name: "eth-daily-momentum-imported",
      code: "class Strategy:\n    existing = True\n",
      language: "python",
      status: "draft",
      time_created: 100,
      time_updated: 100,
    })

    const imported = await importAlgorithmBundle(zipPath, { conflictPolicy: "copy" })

    expect(imported.algorithm.name).toBe("eth-daily-momentum-imported-2")
    expect(imported.algorithm.algorithmId).not.toBe(existing.algorithmId)
    const untouched = await LocalAlgorithmStore.getById(existing.algorithmId)
    expect(untouched?.version).toBe(1)
    expect(untouched?.code).toContain("existing = True")
  })

  test("rejects non-Finny zips without writing to FINNY_HOME", async () => {
    const zipPath = path.join(sandbox, "not-finny.zip")
    await writeNonBundleZip(zipPath)

    await expectRejectedImportWithoutWrites({
      zipPath,
      expectedMessage: "Zip is not a Finny algorithm bundle",
    })
  })

  test("rejects zip entries with path traversal before writing to FINNY_HOME", async () => {
    const zipPath = path.join(sandbox, "unsafe.zip")
    await writeZipWithEntry(zipPath, "open-folder/foo/../evil.txt")

    await expectRejectedImportWithoutWrites({
      zipPath,
      expectedMessage: "Unsafe zip entry path",
    })
  })

  test("rejects unsafe workspace basenames before importing the store", async () => {
    const sourceHome = path.join(sandbox, "source-home")
    const { latest } = await seedSourceAlgorithm(sourceHome)
    const zipPath = path.join(sandbox, "unsafe-basename.zip")
    await writeBundleWithUnsafeWorkspaceBasename(zipPath, latest)

    await expectRejectedImportWithoutWrites({
      zipPath,
      expectedMessage: "safe folder name",
    })
  })
})
