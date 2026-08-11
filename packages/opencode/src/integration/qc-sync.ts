import fs from "node:fs/promises"
import path from "node:path"
import type { Algorithm } from "@/algorithm"
import { leanSourceDir, writeLeanSourceFile, readLeanSourceFile } from "@/backtest/lean/source-store"
import {
  buildQcSourceSnapshot,
  compareSourceTrees,
  qcDriftState,
  qcLanguageFromProject,
  sha256Text,
  sourceTreeHashForFiles,
  type QcProjectLanguage,
  type QcSourceFile,
} from "./qc-contracts"
import { qcFileCreate, qcFileDelete, qcFileUpdate, qcFilesRead, qcProjectsRead } from "./qc-client"
import { readQcCredentials, isQcFixtureMode } from "./quantconnect"
import {
  getProjectLink,
  listProjectLinks,
  loadSourceSnapshot,
  removeProjectLink,
  saveSourceSnapshot,
  updateProjectLinkSync,
  upsertProjectLink,
} from "./qc-store"
import { Global } from "@/global"

/**
 * Project linking and source synchronization for the QC-Native control plane.
 *
 * A link binds one Finny algorithm to one QC project. The immutable local
 * snapshot is compared against the live remote tree before every backtest and
 * deployment. Drift is never resolved silently.
 */

export interface QcSyncDecision {
  ok: boolean
  action?: "in_sync" | "import_qc" | "push_finny" | "blocked"
  error?: string
  drift?: string[]
  link?: Awaited<ReturnType<typeof getProjectLink>>
}

export async function listLinkableProjects(): Promise<
  Array<{ projectId: number; name: string; language: QcProjectLanguage; modified: string }>
> {
  if (isQcFixtureMode()) {
    return [
      { projectId: 24058693, name: "Finny Fixture Python", language: "python", modified: "2026-08-08T00:00:00Z" },
      { projectId: 24058694, name: "Finny Fixture CSharp", language: "csharp", modified: "2026-08-08T00:00:00Z" },
    ]
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const projects = await qcProjectsRead(credentials)
  return projects.map((project) => ({
    projectId: project.projectId,
    name: project.name,
    language: qcLanguageFromProject(project.language),
    modified: project.modified,
  }))
}

export async function remoteSourceFiles(projectId: number | string): Promise<QcSourceFile[]> {
  if (isQcFixtureMode()) return []
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const files = await qcFilesRead(credentials, { projectId, includeLibraries: false })
  return files
    .filter((file) => typeof file.content === "string")
    .map((file) => ({
      path: file.name,
      sha256: sha256Text(file.content),
      bytes: Buffer.byteLength(file.content, "utf8"),
    }))
}

/** The exact local bytes Finny holds for an algorithm version. */
export async function localSourceFilesForAlgorithm(algorithm: Algorithm.Info): Promise<QcSourceFile[]> {
  const tree = await leanSourceDir(algorithm)
  let entries: string[] = []
  try {
    entries = await fs.readdir(tree, { recursive: true })
  } catch {
    entries = []
  }
  const files: QcSourceFile[] = []
  for (const relative of entries.filter((entry) => !entry.startsWith("."))) {
    const full = path.join(tree, relative)
    let stat
    try {
      stat = await fs.stat(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const content = await fs.readFile(full, "utf8")
    files.push({ path: relative.split(path.sep).join("/"), sha256: sha256Text(content), bytes: Buffer.byteLength(content, "utf8") })
  }
  if (files.length === 0 && typeof algorithm.code === "string" && algorithm.code.length > 0) {
    const mainName = algorithm.language === "csharp" ? "Main.cs" : "main.py"
    files.push({ path: mainName, sha256: sha256Text(algorithm.code), bytes: Buffer.byteLength(algorithm.code, "utf8") })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

export async function materializeFilesToLocalTree(
  algorithm: Algorithm.Info,
  files: QcSourceFile[],
  sourceContents: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const file of files) {
    const content = sourceContents.find((item) => item.path === file.path)?.content
    if (content === undefined) continue
    await writeLeanSourceFile({ algorithm, relativePath: file.path, content })
  }
}

export async function readLocalFileContent(algorithm: Algorithm.Info, relativePath: string): Promise<string> {
  try {
    return await readLeanSourceFile({ algorithm, relativePath })
  } catch {
    return ""
  }
}

/**
 * Capture the previous remote tree locally before an explicit overwrite so a
 * client can recover anything Finny replaced.
 */
export async function captureRemoteTree(
  projectId: number | string,
  files: QcSourceFile[],
  sourceContents: Array<{ path: string; content: string }>,
): Promise<string> {
  const dir = path.join(Global.Path.data, "qc-control", "recovery", String(projectId), String(Date.now()))
  await fs.mkdir(dir, { recursive: true })
  for (const file of files) {
    const content = sourceContents.find((item) => item.path === file.path)?.content
    if (content === undefined) continue
    const target = path.join(dir, file.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, { mode: 0o600 })
  }
  return dir
}

export async function replaceRemoteFiles(
  projectId: number | string,
  files: QcSourceFile[],
  contentFor: (relativePath: string) => Promise<string>,
): Promise<void> {
  if (isQcFixtureMode()) return
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const current = await qcFilesRead(credentials, { projectId, includeLibraries: false })
  const currentByPath = new Map(current.map((file) => [file.name, file]))
  const wanted = new Map(files.map((file) => [file.path, file]))
  for (const [name] of currentByPath) {
    if (!wanted.has(name) && !name.startsWith(".")) {
      await qcFileDelete(credentials, { projectId, name })
    }
  }
  for (const file of files) {
    const content = await contentFor(file.path).catch(() => "")
    if (content === "") continue
    const existing = currentByPath.get(file.path)
    if (existing && existing.content === content) continue
    if (existing) {
      await qcFileUpdate(credentials, { projectId, name: file.path, content })
    } else {
      await qcFileCreate(credentials, { projectId, name: file.path, content })
    }
  }
}

/** Link a Finny algorithm to an existing QC project after comparing trees. */
export async function attachProject(input: {
  algorithm: Algorithm.Info
  projectId: number
  projectName?: string
  organizationId?: string
  language?: QcProjectLanguage
  leanVersionId?: number
  mode?: "reuse_local" | "import_remote"
}): Promise<{ link: NonNullable<Awaited<ReturnType<typeof getProjectLink>>>; imported?: boolean }> {
  const existing = await getProjectLink(input.algorithm.algorithmId)
  if (existing && existing.projectId === input.projectId) return { link: existing }

  const local = await localSourceFilesForAlgorithm(input.algorithm)
  const remote = await remoteSourceFiles(input.projectId)
  const comparison = compareSourceTrees(local, remote)
  const chooseRemote = input.mode === "import_remote" || (input.mode === undefined && comparison.added.length > 0 && comparison.removed.length === 0 && comparison.changed.length === 0 && local.length === 0)

  if (chooseRemote) {
    // Adopt the QC project as the algorithm's source.
    await materializeFilesToLocalTree(input.algorithm, remote, await readRemoteContents(input.projectId))
  }

  const finalLocal = await localSourceFilesForAlgorithm(input.algorithm)
  const finalRemote = remote
  const hash = (files: QcSourceFile[]) => sourceTreeHashForFiles(files)
  const link = {
    schema: "finny.qc_project_link" as const,
    version: 1 as const,
    algorithmId: input.algorithm.algorithmId,
    algorithmVersion: input.algorithm.version,
    projectId: input.projectId,
    projectName: input.projectName ?? String(input.projectId),
    organizationId: input.organizationId ?? "",
    language: input.language ?? qcLanguageFromProject(undefined),
    leanVersionId: input.leanVersionId ?? 0,
    sync: {
      state: isQcFixtureMode() || comparison.same ? ("in_sync" as const) : ("both_changed" as const),
      lastSyncedAt: Date.now(),
      lastRemoteTreeHash: hash(finalRemote),
      lastLocalTreeHash: hash(finalLocal),
      driftDetail: comparison.same ? [] : [...comparison.changed, ...comparison.added, ...comparison.removed],
    },
    linkedAt: Date.now(),
    time_updated: Date.now(),
  }
  await upsertProjectLink(link)
  const snapshot = buildQcSourceSnapshot({
    algorithmId: input.algorithm.algorithmId,
    algorithmVersion: input.algorithm.version,
    files: finalLocal,
  })
  await saveSourceSnapshot(snapshot)
  return { link, imported: chooseRemote }
}

async function readRemoteContents(projectId: number | string): Promise<Array<{ path: string; content: string }>> {
  if (isQcFixtureMode()) return []
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const files = await qcFilesRead(credentials, { projectId, includeLibraries: false })
  return files.map((file) => ({ path: file.name, content: file.content }))
}

/** Refresh the stored sync state against the live remote tree. */
export async function refreshLinkSync(algorithm: Algorithm.Info): Promise<QcSyncDecision> {
  const link = await getProjectLink(algorithm.algorithmId)
  if (!link) return { ok: false, error: "algorithm is not linked to a QuantConnect project" }
  const local = await localSourceFilesForAlgorithm(algorithm)
  const remote = await remoteSourceFiles(link.projectId)
  const drift = qcDriftState({
    local,
    remote,
    lastSyncedLocalHash: link.sync.lastLocalTreeHash,
    lastSyncedRemoteHash: link.sync.lastRemoteTreeHash,
  })
  await updateProjectLinkSync(algorithm.algorithmId, {
    state: drift.state,
    lastSyncedAt: Date.now(),
    lastRemoteTreeHash: sourceTreeHashForFiles(remote),
    lastLocalTreeHash: sourceTreeHashForFiles(local),
    driftDetail: drift.detail,
  })
  if (drift.state === "in_sync") return { ok: true, action: "in_sync", drift: [] }
  return {
    ok: false,
    action: drift.state === "qc_changed" ? "import_qc" : drift.state === "finny_changed" ? "push_finny" : "blocked",
    drift: drift.detail,
  }
}

/** Fail-closed preflight used before backtests and deployments. */
export async function syncBeforeRun(algorithm: Algorithm.Info): Promise<QcSyncDecision> {
  if (isQcFixtureMode()) {
    const link = await getProjectLink(algorithm.algorithmId)
    if (!link) return { ok: false, error: "algorithm is not linked to a QuantConnect project" }
    return { ok: true, action: "in_sync", link }
  }
  return refreshLinkSync(algorithm)
}

export async function resolveDrift(input: {
  algorithm: Algorithm.Info
  direction: "import_qc" | "push_finny"
}): Promise<QcSyncDecision> {
  const link = await getProjectLink(input.algorithm.algorithmId)
  if (!link) return { ok: false, error: "algorithm is not linked to a QuantConnect project" }

  if (input.direction === "import_qc") {
    const contents = await readRemoteContents(link.projectId)
    const remote = contents.map((file) => ({
      path: file.path,
      sha256: sha256Text(file.content),
      bytes: Buffer.byteLength(file.content, "utf8"),
    }))
    await materializeFilesToLocalTree(input.algorithm, remote, contents)
  } else {
    const local = await localSourceFilesForAlgorithm(input.algorithm)
    const current = await readRemoteContents(link.projectId)
    await captureRemoteTree(link.projectId, remoteSourceFilesForContents(current), current)
    await replaceRemoteFiles(link.projectId, local, (relativePath) =>
      readLocalFileContent(input.algorithm, relativePath),
    )
  }

  const finalLocal = await localSourceFilesForAlgorithm(input.algorithm)
  const finalRemote = input.direction === "import_qc" ? (await remoteSourceFiles(link.projectId)) : finalLocal
  const updated = await updateProjectLinkSync(input.algorithm.algorithmId, {
    state: "in_sync",
    lastSyncedAt: Date.now(),
    lastRemoteTreeHash: sourceTreeHashForFiles(finalRemote),
    lastLocalTreeHash: sourceTreeHashForFiles(finalLocal),
    driftDetail: [],
  })
  await saveSourceSnapshot(
    buildQcSourceSnapshot({
      algorithmId: input.algorithm.algorithmId,
      algorithmVersion: input.algorithm.version,
      files: finalLocal,
    }),
  )
  return { ok: true, action: "in_sync", link: updated ?? link }
}

function remoteSourceFilesForContents(contents: Array<{ path: string; content: string }>): QcSourceFile[] {
  return contents.map((file) => ({
    path: file.path,
    sha256: sha256Text(file.content),
    bytes: Buffer.byteLength(file.content, "utf8"),
  }))
}

export async function unlinkProject(algorithmId: string): Promise<boolean> {
  return removeProjectLink(algorithmId)
}

export async function isProjectLinked(algorithmId: string): Promise<boolean> {
  return (await getProjectLink(algorithmId)) !== null
}

export { getProjectLink, listProjectLinks, loadSourceSnapshot }
