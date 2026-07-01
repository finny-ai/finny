import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { Filesystem } from "../../util/filesystem"
import { Log } from "../../util/log"
import type { BrokerKind } from "@/live/brokers"
import { finnyArtifactPath } from "@finny-ai/core/prefs"

const log = Log.create({ service: "local-algorithm-store" })

const MAX_RETRY = 5

export interface AlgorithmRow {
  algorithmId: string
  userId: string
  name: string
  code: string
  language: string
  version: number
  status: string
  description?: string
  config?: string
  backtestCode?: string
  reasoning?: string
  brokerKind?: BrokerKind
  targetBrokerage?: BrokerKind
  time_created: number
  time_updated: number
}

export interface AlgorithmMeta {
  algorithmId: string
  userId: string
  name: string
  language: string
  status: string
  brokerKind?: BrokerKind
  targetBrokerage?: BrokerKind
  latestVersion: number
  time_created: number
  time_updated: number
}

function algoDir(algorithmId: string) {
  return path.join(algorithmsDir(), algorithmId)
}

export function algorithmsDir() {
  return finnyArtifactPath("algorithms")
}

function nameIndexPath() {
  return path.join(algorithmsDir(), "_by-name.json")
}

function metaPath(algorithmId: string) {
  return path.join(algoDir(algorithmId), "meta.json")
}

function versionTag(version: number): string {
  return `v${String(version).padStart(2, "0")}`
}

function versionDirPath(algorithmId: string, version: number) {
  return path.join(algoDir(algorithmId), versionTag(version))
}

function codePath(algorithmId: string, version: number) {
  return path.join(versionDirPath(algorithmId, version), "strategy.py")
}

function configPath(algorithmId: string, version: number) {
  return path.join(versionDirPath(algorithmId, version), "config.json")
}

function backtestCodePath(algorithmId: string, version: number) {
  return path.join(versionDirPath(algorithmId, version), "backtest.py")
}

function reasoningPath(algorithmId: string, version: number) {
  return path.join(versionDirPath(algorithmId, version), "reasoning.md")
}

function currentPointerPath(algorithmId: string) {
  return path.join(algoDir(algorithmId), "CURRENT")
}

const DATA_SUBDIRS = [
  "data/stock",
  "data/etf",
  "data/future",
  "data/option",
  "data/crypto",
  "data/sec",
  "data/sentiment",
  "data/news",
]

async function scaffoldAlgoStructure(
  algorithmId: string,
  docs?: { mission?: string; prefs?: string; decisions?: string },
): Promise<void> {
  const dir = algoDir(algorithmId)
  for (const sub of DATA_SUBDIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true })
  }
  const docFiles: Record<string, string> = {
    "mission.md": docs?.mission ?? "",
    "prefs.md": docs?.prefs ?? "",
    "decisions.md": docs?.decisions ?? "",
    "memory.md": "",
  }
  for (const [name, content] of Object.entries(docFiles)) {
    const p = path.join(dir, name)
    try {
      await fs.writeFile(p, content, { flag: "wx" })
    } catch {}
  }
}

async function writeCurrent(algorithmId: string, version: number): Promise<void> {
  await Filesystem.write(currentPointerPath(algorithmId), versionTag(version))
}

async function readMeta(algorithmId: string): Promise<AlgorithmMeta | null> {
  try {
    return await Filesystem.readJson<AlgorithmMeta>(metaPath(algorithmId))
  } catch {
    return null
  }
}

async function writeMeta(meta: AlgorithmMeta): Promise<void> {
  await Filesystem.writeJson(metaPath(meta.algorithmId), meta)
}

async function readNameIndex(): Promise<Record<string, string>> {
  try {
    return await Filesystem.readJson<Record<string, string>>(nameIndexPath())
  } catch {
    return {}
  }
}

async function writeNameIndex(index: Record<string, string>): Promise<void> {
  await Filesystem.writeJson(nameIndexPath(), index)
}

function nameKey(userId: string, name: string): string {
  return `${userId}:${name}`
}

async function rebuildNameIndex(): Promise<Record<string, string>> {
  const index: Record<string, string> = {}
  try {
    const entries = await fs.readdir(algorithmsDir())
    for (const entry of entries) {
      if (entry.startsWith("_")) continue
      const meta = await readMeta(entry)
      if (meta) index[nameKey(meta.userId, meta.name)] = meta.algorithmId
    }
  } catch {
    // empty dir or doesn't exist
  }
  await writeNameIndex(index)
  return index
}

async function scanVersions(algorithmId: string): Promise<number[]> {
  try {
    const entries = await fs.readdir(algoDir(algorithmId), { withFileTypes: true })
    const versions: number[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const m = e.name.match(/^v(\d+)$/)
      if (m) versions.push(parseInt(m[1], 10))
    }
    return versions.sort((a, b) => a - b)
  } catch {
    return []
  }
}

async function scanVersionsInDir(dir: string): Promise<number[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const versions: number[] = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const m = e.name.match(/^v(\d+)$/)
      if (m) versions.push(parseInt(m[1], 10))
    }
    return versions.sort((a, b) => a - b)
  } catch {
    return []
  }
}

async function readVersion(algorithmId: string, version: number, meta: AlgorithmMeta): Promise<AlgorithmRow | null> {
  try {
    const code = await Filesystem.readText(codePath(algorithmId, version))
    let config: string | undefined
    try {
      config = await Filesystem.readText(configPath(algorithmId, version))
    } catch {}
    let backtestCode: string | undefined
    try {
      backtestCode = await Filesystem.readText(backtestCodePath(algorithmId, version))
    } catch {}
    let reasoning: string | undefined
    try {
      reasoning = await Filesystem.readText(reasoningPath(algorithmId, version))
    } catch {}
    return {
      algorithmId: meta.algorithmId,
      userId: meta.userId,
      name: meta.name,
      code,
      language: meta.language ?? "python",
      version,
      status: meta.status,
      description: undefined,
      config,
      backtestCode,
      reasoning,
      brokerKind: meta.brokerKind,
      targetBrokerage: meta.targetBrokerage,
      time_created: meta.time_created,
      time_updated: meta.time_updated,
    }
  } catch {
    return null
  }
}

export namespace LocalAlgorithmStore {
  export interface ImportCopyInput {
    sourceDir: string
    userId: string
    now?: number
  }

  export function directoryFor(algorithmId: string): string {
    return algoDir(algorithmId)
  }

  async function nextImportedName(userId: string, sourceName: string): Promise<string> {
    const base = `${sourceName}-imported`
    if (!(await getByName(userId, base))) return base

    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`
      if (!(await getByName(userId, candidate))) return candidate
    }

    throw new Error(`Unable to find an available imported name for "${sourceName}"`)
  }

  async function assertImportableStoreDir(sourceDir: string, meta: AlgorithmMeta): Promise<void> {
    if (!meta || typeof meta !== "object") throw new Error("Imported algorithm is missing meta.json")
    if (typeof meta.algorithmId !== "string" || !meta.algorithmId) throw new Error("Imported meta.json has no algorithmId")
    if (typeof meta.userId !== "string" || !meta.userId) throw new Error("Imported meta.json has no userId")
    if (typeof meta.name !== "string" || !meta.name) throw new Error("Imported meta.json has no name")
    if (typeof meta.language !== "string" || !meta.language) throw new Error("Imported meta.json has no language")
    if (typeof meta.status !== "string" || !meta.status) throw new Error("Imported meta.json has no status")
    if (!Number.isInteger(meta.latestVersion) || meta.latestVersion < 1) {
      throw new Error("Imported meta.json has an invalid latestVersion")
    }
    if (typeof meta.time_created !== "number" || typeof meta.time_updated !== "number") {
      throw new Error("Imported meta.json has invalid timestamps")
    }

    const versions = await scanVersionsInDir(sourceDir)
    if (!versions.includes(meta.latestVersion)) {
      throw new Error(`Imported algorithm is missing latest version v${String(meta.latestVersion).padStart(2, "0")}`)
    }

    let current: string
    try {
      current = (await fs.readFile(path.join(sourceDir, "CURRENT"), "utf8")).trim()
    } catch {
      throw new Error("Imported algorithm is missing CURRENT")
    }
    const currentMatch = current.match(/^v(\d+)$/)
    if (!currentMatch || !versions.includes(parseInt(currentMatch[1]!, 10))) {
      throw new Error("Imported algorithm CURRENT points at a missing version")
    }

    for (const version of versions) {
      const strategyPath = path.join(sourceDir, versionTag(version), "strategy.py")
      try {
        const stat = await fs.stat(strategyPath)
        if (!stat.isFile()) throw new Error()
      } catch {
        throw new Error(`Imported algorithm version ${versionTag(version)} is missing strategy.py`)
      }
    }
  }

  export async function importCopy(input: ImportCopyInput): Promise<AlgorithmRow> {
    const sourceDir = path.resolve(input.sourceDir)
    const sourceMeta = await Filesystem.readJson<AlgorithmMeta>(path.join(sourceDir, "meta.json"))
    await assertImportableStoreDir(sourceDir, sourceMeta)

    const now = input.now ?? Date.now()
    const importedName = await nextImportedName(input.userId, sourceMeta.name)

    let algorithmId: string
    let targetDir: string
    do {
      algorithmId = crypto.randomUUID()
      targetDir = algoDir(algorithmId)
    } while (await Filesystem.exists(targetDir))

    await fs.mkdir(algorithmsDir(), { recursive: true })
    try {
      await fs.cp(sourceDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
      })

      const meta: AlgorithmMeta = {
        ...sourceMeta,
        algorithmId,
        userId: input.userId,
        name: importedName,
        time_created: now,
        time_updated: now,
      }
      await writeMeta(meta)

      const row = await readVersion(algorithmId, meta.latestVersion, meta)
      if (!row) throw new Error(`Imported algorithm "${importedName}" has no readable latest version`)

      const nameIndex = await readNameIndex()
      nameIndex[nameKey(input.userId, importedName)] = algorithmId
      await writeNameIndex(nameIndex)

      log.info("algorithm imported locally", { algorithmId, name: importedName, version: row.version })
      return row
    } catch (err) {
      await fs.rm(targetDir, { recursive: true, force: true })
      throw err
    }
  }

  export async function insertVersion(values: {
    algorithmId: string
    userId: string
    name: string
    code: string
    language: string
    status: string
    description?: string
    config?: string
    backtestCode?: string
    reasoning?: string
    mission?: string
    prefs?: string
    decisions?: string
    brokerKind?: BrokerKind
    targetBrokerage?: BrokerKind
    time_created: number
    time_updated: number
  }): Promise<AlgorithmRow> {
    const dir = algoDir(values.algorithmId)
    await fs.mkdir(dir, { recursive: true })

    const versions = await scanVersions(values.algorithmId)

    // Deduplicate: skip the version bump if code + config + backtestCode are
    // identical to the latest version. This prevents the agent's validation
    // retries and redundant re-saves from inflating the version number.
    if (versions.length > 0) {
      const latestVer = Math.max(...versions)
      try {
        const prevCode = await Filesystem.readText(codePath(values.algorithmId, latestVer))
        let prevConfig: string | undefined
        try { prevConfig = await Filesystem.readText(configPath(values.algorithmId, latestVer)) } catch {}
        let prevBacktest: string | undefined
        try { prevBacktest = await Filesystem.readText(backtestCodePath(values.algorithmId, latestVer)) } catch {}

        const codeMatch = prevCode === values.code
        const configMatch = (prevConfig ?? "") === (values.config ?? "")
        const backtestMatch = (prevBacktest ?? "") === (values.backtestCode ?? "")

        if (codeMatch && configMatch && backtestMatch) {
          const meta = await readMeta(values.algorithmId)
          if (meta) {
            meta.time_updated = values.time_updated
            await writeMeta(meta)
          }
          log.info("skipped duplicate version", { algorithmId: values.algorithmId, version: latestVer })
          return {
            algorithmId: values.algorithmId,
            userId: values.userId,
            name: values.name,
            code: values.code,
            language: values.language,
            version: latestVer,
            status: values.status,
            description: values.description,
            config: values.config,
            backtestCode: values.backtestCode,
            reasoning: values.reasoning,
            brokerKind: values.brokerKind,
            targetBrokerage: values.targetBrokerage,
            time_created: values.time_created,
            time_updated: values.time_updated,
          }
        }
      } catch {}
    }

    let nextVersion = versions.length > 0 ? Math.max(...versions) + 1 : 1
    let written = false

    // Atomic version claim: mkdir without recursive fails with EEXIST if dir exists
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const vDir = versionDirPath(values.algorithmId, nextVersion)
      try {
        await fs.mkdir(vDir)
        written = true
        break
      } catch (e: any) {
        if (e.code === "EEXIST") {
          nextVersion++
          continue
        }
        throw e
      }
    }

    if (!written) {
      throw new Error(`Failed to write version after ${MAX_RETRY} retries for ${values.algorithmId}`)
    }

    await fs.writeFile(codePath(values.algorithmId, nextVersion), values.code)
    if (values.config) {
      await fs.writeFile(configPath(values.algorithmId, nextVersion), values.config)
    }
    if (values.backtestCode) {
      await fs.writeFile(backtestCodePath(values.algorithmId, nextVersion), values.backtestCode)
    }
    if (values.reasoning) {
      await fs.writeFile(reasoningPath(values.algorithmId, nextVersion), values.reasoning)
    }
    await writeCurrent(values.algorithmId, nextVersion)

    if (nextVersion === 1) {
      await scaffoldAlgoStructure(values.algorithmId, {
        mission: values.mission,
        prefs: values.prefs,
        decisions: values.decisions,
      })
    }

    const meta: AlgorithmMeta = {
      algorithmId: values.algorithmId,
      userId: values.userId,
      name: values.name,
      language: values.language,
      status: values.status,
      brokerKind: values.brokerKind,
      targetBrokerage: values.targetBrokerage,
      latestVersion: nextVersion,
      time_created: values.time_created,
      time_updated: values.time_updated,
    }
    await writeMeta(meta)

    const nameIndex = await readNameIndex()
    nameIndex[nameKey(values.userId, values.name)] = values.algorithmId
    await writeNameIndex(nameIndex)

    log.info("algorithm version written locally", {
      algorithmId: values.algorithmId,
      version: nextVersion,
    })

    return {
      algorithmId: values.algorithmId,
      userId: values.userId,
      name: values.name,
      code: values.code,
      language: values.language,
      version: nextVersion,
      status: values.status,
      description: values.description,
      config: values.config,
      backtestCode: values.backtestCode,
      reasoning: values.reasoning,
      brokerKind: values.brokerKind,
      targetBrokerage: values.targetBrokerage,
      time_created: values.time_created,
      time_updated: values.time_updated,
    }
  }

  export async function patchLatestConfig(algorithmId: string, config: string): Promise<AlgorithmRow | null> {
    const meta = await readMeta(algorithmId)
    if (!meta) return null

    const tmpPath = configPath(algorithmId, meta.latestVersion) + ".tmp"
    const finalPath = configPath(algorithmId, meta.latestVersion)
    await Filesystem.write(tmpPath, config)
    await fs.rename(tmpPath, finalPath)

    const now = Date.now()
    meta.time_updated = now
    await writeMeta(meta)

    const row = await readVersion(algorithmId, meta.latestVersion, meta)
    if (!row) return null
    row.config = config
    row.time_updated = now
    return row
  }

  export async function getById(algorithmId: string): Promise<AlgorithmRow | null> {
    const meta = await readMeta(algorithmId)
    if (!meta) return null
    return readVersion(algorithmId, meta.latestVersion, meta)
  }

  export async function getByIdAndVersion(algorithmId: string, version: number): Promise<AlgorithmRow | null> {
    const meta = await readMeta(algorithmId)
    if (!meta) return null
    return readVersion(algorithmId, version, meta)
  }

  export async function getByName(userId: string, name: string): Promise<AlgorithmRow | null> {
    const key = nameKey(userId, name)
    let nameIndex = await readNameIndex()
    let algorithmId = nameIndex[key]

    if (!algorithmId) {
      nameIndex = await rebuildNameIndex()
      algorithmId = nameIndex[key]
    }
    if (!algorithmId) return null

    const meta = await readMeta(algorithmId)
    if (!meta || meta.userId !== userId) return null

    return readVersion(algorithmId, meta.latestVersion, meta)
  }

  export async function listByUser(userId: string): Promise<AlgorithmRow[]> {
    const results: AlgorithmRow[] = []
    try {
      const entries = await fs.readdir(algorithmsDir())
      for (const entry of entries) {
        if (entry.startsWith("_")) continue
        const meta = await readMeta(entry)
        if (!meta || meta.userId !== userId) continue
        const row = await readVersion(entry, meta.latestVersion, meta)
        if (row) results.push(row)
      }
    } catch {
      // dir doesn't exist yet
    }
    return results.sort((a, b) => b.time_updated - a.time_updated)
  }

  export async function listVersions(algorithmId: string): Promise<AlgorithmRow[]> {
    const meta = await readMeta(algorithmId)
    if (!meta) return []

    const versions = await scanVersions(algorithmId)
    const results: AlgorithmRow[] = []
    for (const v of versions.reverse()) {
      const row = await readVersion(algorithmId, v, meta)
      if (row) results.push(row)
    }
    return results
  }

  export async function updateStatus(algorithmId: string, status: string): Promise<{ algorithmId: string; status: string } | null> {
    const meta = await readMeta(algorithmId)
    if (!meta) return null
    meta.status = status
    meta.time_updated = Date.now()
    await writeMeta(meta)
    return { algorithmId, status }
  }

  export async function remove(algorithmId: string): Promise<{ algorithmId: string; removed: number }> {
    const meta = await readMeta(algorithmId)
    const versions = await scanVersions(algorithmId)

    try {
      await fs.rm(algoDir(algorithmId), { recursive: true, force: true })
    } catch (e) {
      log.warn("failed to remove algorithm directory", { algorithmId, error: e })
    }

    if (meta) {
      const nameIndex = await readNameIndex()
      const key = nameKey(meta.userId, meta.name)
      if (nameIndex[key] === algorithmId) {
        delete nameIndex[key]
        await writeNameIndex(nameIndex)
      }
    }

    log.info("algorithm removed locally", { algorithmId, versions: versions.length })
    return { algorithmId, removed: versions.length }
  }
}
