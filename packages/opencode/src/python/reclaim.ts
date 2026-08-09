import fs from "node:fs/promises"
import path from "node:path"
import { algosRoot, getActiveAlgo, isValidAlgoId, listSessionWorkspaces, MISSION_FILE } from "@finny-ai/core/algo"
import { Python } from "./env"

export type ReclaimKind = "legacy-workspace-env" | "shared-package-env"

export interface ReclaimCandidate {
  kind: ReclaimKind
  path: string
  bytes: number
  lastUsedAt: string
  markerFingerprint: string
}

export interface ReclaimSkip {
  path: string
  reason: string
}

export interface ReclaimPlan {
  dryRun: true
  candidates: ReclaimCandidate[]
  skipped: ReclaimSkip[]
  reclaimableBytes: number
}

export interface ReclaimResult extends Omit<ReclaimPlan, "dryRun"> {
  dryRun: false
  removed: ReclaimCandidate[]
  reclaimedBytes: number
}

export interface ReclaimOptions {
  algoRoot?: string
  sharedRoot?: string
  maxAgeDays?: number
  keepShared?: number
  now?: Date
}

const SHARED_ENV_NAME_RE = /^[a-f0-9]{64}$/

function markerFingerprint(marker: Python.EnvMarker): string {
  return JSON.stringify({
    installer: marker.installer,
    python: marker.python,
    packages: marker.packages,
    verifiedAt: marker.verifiedAt,
  })
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) pending.push(child)
      else if (entry.isFile()) total += (await fs.stat(child)).size
    }
  }
  return total
}

async function isRealChild(candidate: string, root: string): Promise<boolean> {
  const [realCandidate, realRoot] = await Promise.all([fs.realpath(candidate), fs.realpath(root)])
  return realCandidate.startsWith(realRoot + path.sep)
}

async function recognizedEnv(envDir: string): Promise<{ marker: Python.EnvMarker; lastUsedAt: Date } | undefined> {
  const stat = await fs.lstat(envDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
  const marker = await Python.readEnvMarker(envDir)
  if (!marker || marker.python !== Python.pythonBinForEnvDir(envDir)) return undefined
  const py = await fs.stat(marker.python).catch(() => undefined)
  if (!py?.isFile()) return undefined
  const markerStat = await fs.stat(Python.envMarkerPath(envDir))
  return { marker, lastUsedAt: markerStat.mtime }
}

async function legacyCandidates(
  root: string,
  protectedSlugs: Set<string>,
): Promise<{ candidates: ReclaimCandidate[]; skipped: ReclaimSkip[] }> {
  const candidates: ReclaimCandidate[] = []
  const skipped: ReclaimSkip[] = []
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === "ENOENT") return { candidates, skipped }
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidAlgoId(entry.name)) continue
    const workspace = path.join(root, entry.name)
    const envDir = path.join(workspace, ".venv")
    try {
      await fs.stat(path.join(workspace, MISSION_FILE))
      await fs.lstat(envDir)
    } catch {
      continue
    }
    if (protectedSlugs.has(entry.name)) {
      skipped.push({ path: envDir, reason: "workspace is active or bound to a session" })
      continue
    }
    if (!(await isRealChild(envDir, root))) {
      skipped.push({ path: envDir, reason: "path escapes the Finny algos root" })
      continue
    }
    const recognized = await recognizedEnv(envDir)
    if (!recognized) {
      skipped.push({ path: envDir, reason: "not a marker-verified Finny environment" })
      continue
    }
    candidates.push({
      kind: "legacy-workspace-env",
      path: envDir,
      bytes: await directoryBytes(envDir),
      lastUsedAt: recognized.lastUsedAt.toISOString(),
      markerFingerprint: markerFingerprint(recognized.marker),
    })
  }
  return { candidates, skipped }
}

async function sharedCandidates(
  root: string,
  options: Required<Pick<ReclaimOptions, "maxAgeDays" | "keepShared" | "now">>,
): Promise<{ candidates: ReclaimCandidate[]; skipped: ReclaimSkip[] }> {
  const candidates: ReclaimCandidate[] = []
  const skipped: ReclaimSkip[] = []
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === "ENOENT") return { candidates, skipped }
    throw error
  }
  const recognized: Array<{
    path: string
    marker: Python.EnvMarker
    lastUsedAt: Date
  }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SHARED_ENV_NAME_RE.test(entry.name)) continue
    const envDir = path.join(root, entry.name)
    if (!(await isRealChild(envDir, root))) {
      skipped.push({ path: envDir, reason: "path escapes the managed shared-environment root" })
      continue
    }
    const env = await recognizedEnv(envDir)
    if (!env) {
      skipped.push({ path: envDir, reason: "not a marker-verified Finny environment" })
      continue
    }
    if (Python.packageSetHash(env.marker.packages) !== entry.name) {
      skipped.push({ path: envDir, reason: "directory hash does not match the marker package set" })
      continue
    }
    recognized.push({ path: envDir, ...env })
  }
  recognized.sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
  const cutoff = options.now.getTime() - options.maxAgeDays * 86_400_000
  for (const [index, env] of recognized.entries()) {
    if (index < options.keepShared || env.lastUsedAt.getTime() >= cutoff) continue
    if (await Python.hasLiveEnvLease(env.path)) {
      skipped.push({ path: env.path, reason: "environment has a live Finny process lease" })
      continue
    }
    candidates.push({
      kind: "shared-package-env",
      path: env.path,
      bytes: await directoryBytes(env.path),
      lastUsedAt: env.lastUsedAt.toISOString(),
      markerFingerprint: markerFingerprint(env.marker),
    })
  }
  return { candidates, skipped }
}

export async function planPythonEnvReclaim(options: ReclaimOptions = {}): Promise<ReclaimPlan> {
  const algoRoot = path.resolve(options.algoRoot ?? algosRoot())
  const sharedRoot = path.resolve(options.sharedRoot ?? Python.sharedEnvsRoot())
  const active = await getActiveAlgo()
  const bindings = await listSessionWorkspaces()
  const protectedSlugs = new Set(bindings.map((item) => item.slug))
  if (active) protectedSlugs.add(active)
  const retention = {
    maxAgeDays: Math.max(1, options.maxAgeDays ?? 30),
    keepShared: Math.max(0, options.keepShared ?? 8),
    now: options.now ?? new Date(),
  }
  const [legacy, shared] = await Promise.all([
    legacyCandidates(algoRoot, protectedSlugs),
    sharedCandidates(sharedRoot, retention),
  ])
  const candidates = [...legacy.candidates, ...shared.candidates]
  return {
    dryRun: true,
    candidates,
    skipped: [...legacy.skipped, ...shared.skipped],
    reclaimableBytes: candidates.reduce((sum, item) => sum + item.bytes, 0),
  }
}

async function removeCandidate(candidate: ReclaimCandidate, algoRoot: string, sharedRoot: string): Promise<boolean> {
  const expectedRoot = candidate.kind === "legacy-workspace-env" ? algoRoot : sharedRoot
  if (!(await isRealChild(candidate.path, expectedRoot))) return false
  if (candidate.kind === "legacy-workspace-env") {
    const slug = path.basename(path.dirname(candidate.path))
    const active = await getActiveAlgo()
    const bindings = await listSessionWorkspaces()
    if (active === slug || bindings.some((item) => item.slug === slug)) return false
  }
  const recognized = await recognizedEnv(candidate.path)
  if (
    !recognized ||
    markerFingerprint(recognized.marker) !== candidate.markerFingerprint ||
    recognized.lastUsedAt.toISOString() !== candidate.lastUsedAt
  )
    return false
  const remove = async () => {
    if (candidate.kind === "legacy-workspace-env") {
      const slug = path.basename(path.dirname(candidate.path))
      const [active, bindings] = await Promise.all([getActiveAlgo(), listSessionWorkspaces()])
      if (active === slug || bindings.some((item) => item.slug === slug)) return false
    }
    if (await Python.hasLiveEnvLease(candidate.path)) return false
    const current = await recognizedEnv(candidate.path)
    if (
      !current ||
      markerFingerprint(current.marker) !== candidate.markerFingerprint ||
      current.lastUsedAt.toISOString() !== candidate.lastUsedAt
    )
      return false
    await fs.rm(candidate.path, { recursive: true })
    return true
  }
  return Python.withFilesystemEnvLock(candidate.path, remove)
}

export async function applyPythonEnvReclaim(plan: ReclaimPlan, options: ReclaimOptions = {}): Promise<ReclaimResult> {
  const algoRoot = path.resolve(options.algoRoot ?? algosRoot())
  const sharedRoot = path.resolve(options.sharedRoot ?? Python.sharedEnvsRoot())
  const removed: ReclaimCandidate[] = []
  const skipped = [...plan.skipped]
  for (const candidate of plan.candidates) {
    if (await removeCandidate(candidate, algoRoot, sharedRoot)) removed.push(candidate)
    else skipped.push({ path: candidate.path, reason: "changed or became active after the dry-run plan" })
  }
  return {
    dryRun: false,
    candidates: plan.candidates,
    skipped,
    reclaimableBytes: plan.reclaimableBytes,
    removed,
    reclaimedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
  }
}
