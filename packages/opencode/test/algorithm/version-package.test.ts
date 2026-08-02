import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DeviceProfile } from "../../src/device"
import { AlgorithmVersionPackage } from "../../src/algorithm/version-package"
import { LocalAlgorithmStore } from "../../src/storage/local/algorithm-store"
import { currentAlgorithmHashes } from "../../src/backtest/run-integrity"
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"

let sandbox: string
let savedEnv: NodeJS.ProcessEnv

async function saveFixture(algorithmId = "canonical-algo", name = "canonical-name") {
  return LocalAlgorithmStore.insertVersion({
    algorithmId,
    userId: "source-user",
    name,
    code: "class Strategy:\n    pass\n",
    language: "python",
    status: "draft",
    description: "canonical fixture",
    config: '{"symbol":"SPY"}\n',
    backtestCode: "print('canonical')\n",
    reasoning: "reasoning\n",
    mission: "mission\n",
    prefs: "prefs\n",
    decisions: "decision\n",
    riskContract: "{}\n",
    docsMode: "replace",
    brokerKind: "ibkr",
    targetBrokerage: "binance",
    time_created: 10,
    time_updated: 20,
  })
}

async function duplicateEntryArchive(filename: string): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add(filename, new Uint8ArrayReader(new Uint8Array([1])), { useWebWorkers: false })
  await writer.add("config.json", new Uint8ArrayReader(new Uint8Array([2])), { useWebWorkers: false })
  const archive = new Uint8Array(await (await writer.close()).arrayBuffer())
  const source = new TextEncoder().encode("config.json")
  const replacement = new TextEncoder().encode(filename)
  for (let offset = 0; offset <= archive.length - source.length; offset++) {
    if (source.every((byte, index) => archive[offset + index] === byte)) archive.set(replacement, offset)
  }
  return archive
}

beforeEach(async () => {
  savedEnv = { ...process.env }
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-version-package-"))
  process.env.FINNY_HOME = path.join(sandbox, "source")
  DeviceProfile._setStateDirForTests(path.join(sandbox, "device"))
})

afterEach(async () => {
  process.env = savedEnv
  DeviceProfile._resetForTests()
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe.serial("canonical algorithm version package", () => {
  test("packages only the saved-version allowlist with stable hashes", async () => {
    const row = await saveFixture()
    const versionDir = path.join(LocalAlgorithmStore.directoryFor(row.algorithmId), "v01")
    await fs.mkdir(path.join(versionDir, "runs", "ignored"), { recursive: true })
    await fs.writeFile(path.join(versionDir, "runs", "ignored", "result.json"), "{}")
    await fs.writeFile(path.join(versionDir, "scratch.txt"), "ignored")

    const first = await AlgorithmVersionPackage.build({ algorithmId: row.algorithmId, version: 1 })
    const second = await AlgorithmVersionPackage.build({ algorithmId: row.algorithmId, version: 1 })
    const verified = await AlgorithmVersionPackage.verify(first.archive)

    expect(first.manifest.payloadHash).toBe(second.manifest.payloadHash)
    expect(first.archiveSha256).toBe(second.archiveSha256)
    expect([...verified.files.keys()]).toEqual([
      "backtest.py",
      "config.json",
      "decisions.md",
      "mission.md",
      "prefs.md",
      "reasoning.md",
      "risk.json",
      "strategy.py",
    ])
    expect(first.manifest.files.map((file) => file.path)).not.toContain("scratch.txt")
    expect(first.manifest.files.some((file) => file.path.startsWith("runs/"))).toBe(false)
  })

  test("rejects an oversized canonical version before archive allocation", async () => {
    const row = await saveFixture()
    const versionDir = path.join(LocalAlgorithmStore.directoryFor(row.algorithmId), "v01")
    for (const file of ["strategy.py", "config.json", "reasoning.md"]) {
      await fs.truncate(path.join(versionDir, file), 11 * 1024 * 1024)
    }
    await expect(AlgorithmVersionPackage.build({ algorithmId: row.algorithmId, version: 1 })).rejects.toThrow(
      "maximum total size",
    )
  })

  test("rejects traversal, unknown entries, and hash-invalid payloads before materialization", async () => {
    const row = await saveFixture()
    const built = await AlgorithmVersionPackage.build({ algorithmId: row.algorithmId, version: 1 })
    const verified = await AlgorithmVersionPackage.verify(built.archive)

    const traversal = new Map(verified.files)
    traversal.set(
      AlgorithmVersionPackage.VERSION_PACKAGE_MANIFEST,
      new TextEncoder().encode(JSON.stringify(built.manifest)),
    )
    traversal.set("../escape", new Uint8Array([1]))
    await expect(
      AlgorithmVersionPackage.verify(await AlgorithmVersionPackage.createArchive(traversal)),
    ).rejects.toThrow("Unsafe package entry path")

    const unknown = new Map(verified.files)
    unknown.set(
      AlgorithmVersionPackage.VERSION_PACKAGE_MANIFEST,
      new TextEncoder().encode(JSON.stringify(built.manifest)),
    )
    unknown.set("workspace.tmp", new Uint8Array([1]))
    await expect(AlgorithmVersionPackage.verify(await AlgorithmVersionPackage.createArchive(unknown))).rejects.toThrow(
      "Unknown package entry",
    )

    const tampered = new Map(verified.files)
    tampered.set("strategy.py", new TextEncoder().encode("tampered\n"))
    tampered.set(
      AlgorithmVersionPackage.VERSION_PACKAGE_MANIFEST,
      new TextEncoder().encode(JSON.stringify(built.manifest)),
    )
    await expect(AlgorithmVersionPackage.verify(await AlgorithmVersionPackage.createArchive(tampered))).rejects.toThrow(
      "Package byte count mismatch",
    )

    await expect(AlgorithmVersionPackage.verify(await duplicateEntryArchive("strategy.py"))).rejects.toThrow(
      "Duplicate package entry",
    )
  })

  test("materializes exact identity idempotently and rejects byte or name collisions", async () => {
    const source = await saveFixture()
    const sourceHashes = await currentAlgorithmHashes(source as any)
    const built = await AlgorithmVersionPackage.build({ algorithmId: source.algorithmId, version: source.version })
    const catalog = {
      algorithmId: source.algorithmId,
      name: source.name,
      version: source.version,
      language: source.language,
      status: source.status,
      description: source.description,
      brokerKind: source.brokerKind,
      targetBrokerage: source.targetBrokerage,
      timeCreated: source.time_created,
      timeUpdated: source.time_updated,
    }

    process.env.FINNY_HOME = path.join(sandbox, "destination")
    const first = await AlgorithmVersionPackage.materialize({ archive: built.archive, catalog })
    const second = await AlgorithmVersionPackage.materialize({ archive: built.archive, catalog })
    expect(first.algorithmId).toBe(source.algorithmId)
    expect(first.version).toBe(source.version)
    expect(second).toEqual(first)
    expect(await currentAlgorithmHashes(first as any)).toEqual(sourceHashes)
    expect(first.userId).not.toBe("source-user")
    expect(await fs.readFile(path.join(LocalAlgorithmStore.directoryFor(source.algorithmId), "CURRENT"), "utf8")).toBe(
      "v01",
    )

    await fs.writeFile(
      path.join(LocalAlgorithmStore.directoryFor(source.algorithmId), "v01", "strategy.py"),
      "conflict\n",
    )
    await expect(AlgorithmVersionPackage.materialize({ archive: built.archive, catalog })).rejects.toThrow(
      "Conflicting bytes",
    )

    await LocalAlgorithmStore.insertVersion({
      algorithmId: "different-local-id",
      userId: first.userId,
      name: "occupied-name",
      code: "class Strategy: pass\n",
      language: "python",
      status: "draft",
      time_created: 1,
      time_updated: 1,
    })
    process.env.FINNY_HOME = path.join(sandbox, "source")
    const other = await saveFixture("central-other-id", "occupied-name")
    const otherBuilt = await AlgorithmVersionPackage.build({ algorithmId: other.algorithmId, version: 1 })
    process.env.FINNY_HOME = path.join(sandbox, "destination")
    await expect(
      AlgorithmVersionPackage.materialize({
        archive: otherBuilt.archive,
        catalog: {
          algorithmId: other.algorithmId,
          name: other.name,
          version: 1,
          language: other.language,
          status: other.status,
          timeCreated: other.time_created,
          timeUpdated: other.time_updated,
        },
      }),
    ).rejects.toThrow("Algorithm name collision")
  })

  test("adding an older version preserves newer CURRENT metadata", async () => {
    const v1 = await saveFixture("out-of-order-algo", "out-of-order-name")
    const v2 = await LocalAlgorithmStore.insertVersion({
      algorithmId: v1.algorithmId,
      userId: v1.userId,
      name: v1.name,
      code: "class Strategy:\n    version = 2\n",
      language: "python",
      status: "ready",
      description: "newer metadata",
      config: '{"symbol":"QQQ"}\n',
      reasoning: "v2 reasoning\n",
      docsMode: "inherit",
      brokerKind: "ibkr",
      targetBrokerage: "binance",
      time_created: 10,
      time_updated: 200,
    })
    const packageV1 = await AlgorithmVersionPackage.build({ algorithmId: v1.algorithmId, version: 1 })
    const packageV2 = await AlgorithmVersionPackage.build({ algorithmId: v1.algorithmId, version: 2 })

    process.env.FINNY_HOME = path.join(sandbox, "out-of-order-destination")
    await AlgorithmVersionPackage.materialize({
      archive: packageV2.archive,
      catalog: {
        algorithmId: v2.algorithmId,
        name: v2.name,
        version: 2,
        language: v2.language,
        status: v2.status,
        description: v2.description,
        brokerKind: v2.brokerKind,
        targetBrokerage: v2.targetBrokerage,
        timeCreated: v2.time_created,
        timeUpdated: v2.time_updated,
      },
    })
    const older = await AlgorithmVersionPackage.materialize({
      archive: packageV1.archive,
      catalog: {
        algorithmId: v1.algorithmId,
        name: v1.name,
        version: 1,
        language: "legacy-python",
        status: "legacy",
        description: "older metadata",
        brokerKind: "tradier",
        targetBrokerage: "schwab",
        timeCreated: 1,
        timeUpdated: 999,
      },
    })

    const current = await LocalAlgorithmStore.getById(v1.algorithmId)
    expect(current).toMatchObject({
      version: 2,
      language: "python",
      status: "ready",
      description: "newer metadata",
      brokerKind: "ibkr",
      targetBrokerage: "binance",
      time_updated: 200,
    })
    expect(older).toMatchObject({
      version: 1,
      language: "legacy-python",
      status: "legacy",
      description: "older metadata",
    })
    expect(await LocalAlgorithmStore.getByIdAndVersion(v1.algorithmId, 1)).toMatchObject({
      version: 1,
      language: "legacy-python",
      status: "legacy",
      description: "older metadata",
    })
    expect((await LocalAlgorithmStore.listVersions(v1.algorithmId)).map((version) => version.version)).toEqual([2, 1])
    expect(await fs.readFile(path.join(LocalAlgorithmStore.directoryFor(v1.algorithmId), "CURRENT"), "utf8")).toBe(
      "v02",
    )
  })
})
