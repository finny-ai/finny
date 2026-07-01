import fs from "node:fs/promises"
import path from "node:path"

export type AlgorithmFolderKind = "workspace" | "store"

export type AlgorithmFolderResult =
  | {
      found: true
      kind: AlgorithmFolderKind
      path: string
    }
  | {
      found: false
    }

export interface AlgorithmFolderRequest {
  algorithmId: string
  name: string
  algosRoot: string
  algorithmsRoot: string
}

interface ManifestEntry {
  name?: unknown
  algorithmId?: unknown
  updated?: unknown
}

interface RequestJson {
  requested_algorithm_name?: unknown
  updated?: unknown
}

interface WorkspaceCandidate {
  dir: string
  updated: string
}

type ManifestCandidate = WorkspaceCandidate | "skip-workspace" | undefined
type WorkspaceEntry = import("node:fs").Dirent

interface PathArg {
  path: string
}

interface ValueArg {
  value: string
}

interface NamedPair {
  left: string
  right: string
}

interface WorkspaceDirArg {
  dir: string
}

interface WorkspaceCandidateArgs extends WorkspaceDirArg {
  request: AlgorithmFolderRequest
}

interface RequestCandidateArgs extends WorkspaceCandidateArgs {
  fallbackUpdated: string
}

async function isDirectory(input: PathArg): Promise<boolean> {
  try {
    return (await fs.stat(input.path)).isDirectory()
  } catch {
    return false
  }
}

function hasAlgorithmId(entry: ManifestEntry): entry is ManifestEntry & { algorithmId: string } {
  return typeof entry.algorithmId === "string" && entry.algorithmId.trim().length > 0
}

function matchingManifestEntry(raw: unknown, request: AlgorithmFolderRequest): ManifestEntry | undefined {
  const manifest = raw as { algorithms?: unknown }
  if (!Array.isArray(manifest.algorithms)) return undefined

  let nameOnlyMatch: ManifestEntry | undefined
  for (const entry of manifest.algorithms) {
    const item = entry as ManifestEntry
    if (item.algorithmId === request.algorithmId) return item
    if (!hasAlgorithmId(item) && item.name === request.name) nameOnlyMatch = item
  }
  return nameOnlyMatch
}

function hasConflictingManifestName(raw: unknown, request: AlgorithmFolderRequest): boolean {
  const manifest = raw as { algorithms?: unknown }
  if (!Array.isArray(manifest.algorithms)) return false

  return manifest.algorithms.some((entry) => {
    const item = entry as ManifestEntry
    return item.name === request.name && hasAlgorithmId(item) && item.algorithmId !== request.algorithmId
  })
}

function normalizeName(input: ValueArg): string {
  return input.value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
}

function workspaceBaseName(input: WorkspaceDirArg): string {
  return normalizeName({ value: path.basename(input.dir).split(".")[0] ?? "" })
}

function namesOverlap(input: NamedPair): boolean {
  const { left, right } = input
  if (!left || !right) return false
  return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`)
}

function matchingRequestJson(raw: unknown, dir: WorkspaceDirArg, request: AlgorithmFolderRequest): RequestJson | undefined {
  const info = raw as RequestJson
  const requestName = normalizeName({ value: request.name })
  const workspaceName = workspaceBaseName(dir)
  const requestedAlgorithmName =
    typeof info.requested_algorithm_name === "string"
      ? normalizeName({ value: info.requested_algorithm_name })
      : ""

  if (namesOverlap({ left: requestName, right: requestedAlgorithmName })) return info
  if (namesOverlap({ left: requestName, right: workspaceName })) return info
  return undefined
}

async function readJsonFile(input: PathArg): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(input.path, "utf8"))
  } catch {
    return undefined
  }
}

async function manifestCandidate(input: WorkspaceCandidateArgs): Promise<ManifestCandidate> {
  const manifest = await readJsonFile({ path: path.join(input.dir, "manifest.json") })
  if (!manifest) return undefined

  const match = matchingManifestEntry(manifest, input.request)
  if (match) {
    return {
      dir: input.dir,
      updated: typeof match.updated === "string" ? match.updated : "",
    }
  }

  return hasConflictingManifestName(manifest, input.request) ? "skip-workspace" : undefined
}

async function requestCandidate(input: RequestCandidateArgs): Promise<WorkspaceCandidate | undefined> {
  const requestJson = await readJsonFile({ path: path.join(input.dir, "request.json") })
  const match = requestJson
    ? matchingRequestJson(requestJson, { dir: input.dir }, input.request)
    : undefined
  if (!match) return undefined

  return {
    dir: input.dir,
    updated: typeof match.updated === "string" ? match.updated : input.fallbackUpdated,
  }
}

async function readWorkspaceEntries(request: AlgorithmFolderRequest): Promise<WorkspaceEntry[]> {
  try {
    return await fs.readdir(request.algosRoot, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === "ENOENT") return []
    throw err
  }
}

function visibleWorkspaceEntry(entry: WorkspaceEntry): boolean {
  return entry.isDirectory() && !entry.name.startsWith(".")
}

async function candidateForEntry(entry: WorkspaceEntry, request: AlgorithmFolderRequest): Promise<WorkspaceCandidate | undefined> {
  if (!visibleWorkspaceEntry(entry)) return undefined

  const dir = path.join(request.algosRoot, entry.name)
  const stat = await fs.stat(dir)

  const manifestMatch = await manifestCandidate({ dir, request })
  if (manifestMatch === "skip-workspace") return undefined
  if (manifestMatch) return manifestMatch

  return requestCandidate({ dir, request, fallbackUpdated: stat.mtime.toISOString() })
}

function isWorkspaceCandidate(candidate: WorkspaceCandidate | undefined): candidate is WorkspaceCandidate {
  return candidate !== undefined
}

async function workspaceCandidates(request: AlgorithmFolderRequest): Promise<WorkspaceCandidate[]> {
  const entries = await readWorkspaceEntries(request)
  const candidates = await Promise.all(entries.map((entry) => candidateForEntry(entry, request)))
  return candidates.filter(isWorkspaceCandidate)
}

export async function resolveAlgorithmFolder(request: AlgorithmFolderRequest): Promise<AlgorithmFolderResult> {
  const workspaces = await workspaceCandidates(request)
  if (workspaces.length > 0) {
    workspaces.sort((a, b) => b.updated.localeCompare(a.updated) || b.dir.localeCompare(a.dir))
    return { found: true, kind: "workspace", path: workspaces[0]!.dir }
  }

  const storePath = path.join(request.algorithmsRoot, request.algorithmId)
  if (await isDirectory({ path: storePath })) {
    return { found: true, kind: "store", path: storePath }
  }

  return { found: false }
}
