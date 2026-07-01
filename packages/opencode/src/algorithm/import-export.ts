import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import {
  ZipReader,
  ZipWriter,
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  configure,
} from "@zip.js/zip.js"
import { finnyHomeArtifacts } from "@finny-ai/core/prefs"
import { DeviceProfile } from "../device"
import { LocalAlgorithmStore } from "../storage/local/algorithm-store"
import type { Algorithm } from "."
import { resolveAlgorithmFolder, type AlgorithmFolderKind } from "./folder"

const BUNDLE_SCHEMA = "finny.algorithm.bundle"
export const ALGORITHM_BUNDLE_MANIFEST = "finny-algorithm-bundle.json"

const ZIP_OPTIONS = { useWebWorkers: false } as const
configure(ZIP_OPTIONS)

const EXPORT_EXCLUDED_DIRS = new Set([".venv", "node_modules", "__pycache__", ".pytest_cache"])
const EXPORT_EXCLUDED_FILES = new Set([".DS_Store"])
const MAX_BUNDLE_ENTRIES = 100_000
const MAX_BUNDLE_ENTRY_BYTES = 250 * 1024 * 1024
const MAX_BUNDLE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024

const BundleManifest = z.object({
  schema: z.literal(BUNDLE_SCHEMA),
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  source: z.object({
    algorithmId: z.string().min(1),
    name: z.string().min(1),
    version: z.number().int().positive(),
  }),
  openFolder: z.object({
    kind: z.enum(["workspace", "store"]),
    basename: z.string().min(1).refine((value) => isSafePathSegment(value), "must be a safe folder name"),
  }),
})
type BundleManifest = z.infer<typeof BundleManifest>

export interface ExportAlgorithmBundleResult {
  zipPath: string
  bytes: number
  openFolderKind: AlgorithmFolderKind
  openFolderPath: string
  storePath: string
}

export interface ImportAlgorithmBundleOptions {
  conflictPolicy?: "copy"
}

export interface ImportAlgorithmBundleResult {
  algorithm: Algorithm.Info
  copiedWorkspacePath?: string
}

interface ZipEntryLike {
  filename: string
  directory?: boolean
  uncompressedSize?: number
  getData?: (writer: Uint8ArrayWriter, options?: typeof ZIP_OPTIONS) => Promise<Uint8Array>
}
type ReadableZipEntry = ZipEntryLike & { getData: NonNullable<ZipEntryLike["getData"]> }

interface PathWithLabel {
  filePath: string
  label: string
}

interface NativePath {
  value: string
}

interface PathInput {
  path: string
}

interface PathSegmentInput {
  value: string
  label: string
}

interface ZipEntryNameInput {
  filename: string
}

interface ExtractTargetInput extends ZipEntryNameInput {
  root: string
}

interface RootBoundaryInput extends ExtractTargetInput {
  target: string
}

interface TreeSection {
  sourceDir: string
  zipRoot: string
}

interface AddTreeInput {
  writer: ZipWriter<Blob>
  section: TreeSection
}

interface WriteZipInput {
  destZipPath: string
  manifest: BundleManifest
  sections: TreeSection[]
}

interface ReadZipEntriesInput<T> {
  zipPath: string
  onEntries: (entries: ZipEntryLike[]) => Promise<T>
}

interface ExtractBundleZipInput {
  zipPath: string
  destDir: string
}

interface ZipEntriesInput {
  entries: ZipEntryLike[]
}

interface ExtractZipEntryInput {
  entry: ZipEntryLike
  destDir: string
}

interface WorkspaceRootInput {
  root: string
}

interface ImportedWorkspacePathInput extends WorkspaceRootInput {
  basename: string
}

function assertAbsoluteFilePath(input: PathWithLabel): string {
  const { filePath, label } = input
  const resolved = path.resolve(filePath)
  if (!path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`)
  return resolved
}

function toZipPath(input: NativePath): string {
  return input.value.split(path.sep).join("/")
}

function isSafePathSegment(value: string): boolean {
  return ![
    !value,
    value === ".",
    value === "..",
    value.includes("/"),
    value.includes("\\"),
    value.includes("\0"),
    /^[A-Za-z]:/.test(value),
    path.basename(value) !== value,
    path.posix.basename(value) !== value,
  ].some(Boolean)
}

function assertSafePathSegment(input: PathSegmentInput): string {
  if (!isSafePathSegment(input.value)) throw new Error(`${input.label} must be a safe folder name`)
  return input.value
}

function safeBasename(input: PathInput): string {
  const base = path.basename(input.path)
  return assertSafePathSegment({ value: base, label: `Folder basename for ${input.path}` })
}

function isSafeZipEntryName(input: ZipEntryNameInput): boolean {
  const { filename } = input
  const normalized = path.posix.normalize(filename)
  return ![
    !filename,
    filename.includes("\\"),
    filename.startsWith("/"),
    /^[A-Za-z]:/.test(filename),
    filename.split("/").includes(".."),
    normalized === ".",
    normalized === "..",
    normalized.startsWith("../"),
  ].some(Boolean)
}

function assertSafeZipEntryName(input: ZipEntryNameInput): void {
  if (!isSafeZipEntryName(input)) throw new Error(`Unsafe zip entry path: ${input.filename}`)
}

function isOutsideRoot(input: RootBoundaryInput): boolean {
  const rel = path.relative(input.root, input.target)
  return [rel === "..", rel.startsWith(`..${path.sep}`), path.isAbsolute(rel)].some(Boolean)
}

function assertTargetInsideRoot(input: RootBoundaryInput): void {
  if (isOutsideRoot(input)) throw new Error(`Unsafe zip entry path: ${input.filename}`)
}

function extractTarget(input: ExtractTargetInput): string {
  const { root, filename } = input
  assertSafeZipEntryName({ filename })
  const segments = filename.split("/").filter(Boolean)
  const target = path.resolve(root, ...segments)
  assertTargetInsideRoot({ root, target, filename })
  return target
}

function shouldSkipExportEntry(entry: import("node:fs").Dirent): boolean {
  return [
    entry.isDirectory() && EXPORT_EXCLUDED_DIRS.has(entry.name),
    entry.isFile() && EXPORT_EXCLUDED_FILES.has(entry.name),
  ].some(Boolean)
}

async function sortedDirEntries(input: PathInput): Promise<import("node:fs").Dirent[]> {
  return (await fs.readdir(input.path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
}

async function addTree(input: AddTreeInput): Promise<void> {
  const { writer, section } = input
  const { sourceDir, zipRoot } = section
  const sourceRoot = path.resolve(sourceDir)
  const rootEntry = zipRoot.endsWith("/") ? zipRoot : `${zipRoot}/`
  await writer.add(rootEntry, undefined, { directory: true, ...ZIP_OPTIONS })

  async function visit(input: PathInput): Promise<void> {
    const entries = await sortedDirEntries(input)
    for (const entry of entries) {
      if (shouldSkipExportEntry(entry)) continue
      const fullPath = path.join(input.path, entry.name)
      const stat = await fs.lstat(fullPath)
      if (stat.isSymbolicLink()) continue

      const rel = toZipPath({ value: path.relative(sourceRoot, fullPath) })
      const zipName = `${zipRoot}/${rel}`
      if (entry.isDirectory()) {
        await writer.add(`${zipName}/`, undefined, { directory: true, ...ZIP_OPTIONS })
        await visit({ path: fullPath })
        continue
      }
      if (!entry.isFile()) continue
      const bytes = await fs.readFile(fullPath)
      await writer.add(zipName, new Uint8ArrayReader(bytes), ZIP_OPTIONS)
    }
  }

  await visit({ path: sourceRoot })
}

async function writeZip(input: WriteZipInput) {
  const { destZipPath, manifest, sections } = input
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  await writer.add(ALGORITHM_BUNDLE_MANIFEST, new Uint8ArrayReader(Buffer.from(JSON.stringify(manifest, null, 2))), ZIP_OPTIONS)
  for (const section of sections) {
    await addTree({ writer, section })
  }
  const zipBlob = await writer.close()
  const zipData = new Uint8Array(await zipBlob.arrayBuffer())
  await fs.mkdir(path.dirname(destZipPath), { recursive: true })
  await fs.writeFile(destZipPath, zipData)
  return zipData.byteLength
}

async function readZipEntries<T>(input: ReadZipEntriesInput<T>): Promise<T> {
  const { zipPath, onEntries } = input
  const bytes = await fs.readFile(zipPath)
  const reader = new ZipReader(new BlobReader(new Blob([bytes])), ZIP_OPTIONS)
  try {
    const entries = (await reader.getEntries()) as ZipEntryLike[]
    return await onEntries(entries)
  } finally {
    await reader.close()
  }
}

function zipEntryKey(input: ZipEntryNameInput): string {
  return input.filename.replace(/\/+$/, "")
}

function assertUniqueZipEntry(input: ZipEntryNameInput & { seen: Set<string> }): void {
  const key = zipEntryKey(input)
  if (input.seen.has(key)) throw new Error(`Duplicate zip entry path: ${input.filename}`)
  input.seen.add(key)
}

function assertBundleEntryCount(entries: ZipEntryLike[]): void {
  if (entries.length > MAX_BUNDLE_ENTRIES) throw new Error(`Algorithm bundle has too many entries: ${entries.length}`)
}

function zipEntryUncompressedSize(entry: ZipEntryLike): number | undefined {
  if (typeof entry.uncompressedSize !== "number") return undefined
  if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0) {
    throw new Error(`Invalid zip entry size: ${entry.filename}`)
  }
  if (entry.uncompressedSize > MAX_BUNDLE_ENTRY_BYTES) throw new Error(`Zip entry is too large: ${entry.filename}`)
  return entry.uncompressedSize
}

function totalKnownUncompressedSize(entries: ZipEntryLike[]): number {
  return entries.reduce((total, entry) => total + (zipEntryUncompressedSize(entry) ?? 0), 0)
}

function assertZipEntryLimits(input: ZipEntriesInput): void {
  assertBundleEntryCount(input.entries)
  if (totalKnownUncompressedSize(input.entries) > MAX_BUNDLE_UNCOMPRESSED_BYTES) throw new Error("Algorithm bundle is too large")
}

function validateZipEntries(input: ZipEntriesInput): void {
  assertZipEntryLimits(input)
  const seen = new Set<string>()
  for (const entry of input.entries) {
    assertSafeZipEntryName({ filename: entry.filename })
    assertUniqueZipEntry({ filename: entry.filename, seen })
  }
}

function bundleManifestEntry(input: ZipEntriesInput): ReadableZipEntry {
  const manifestEntry = input.entries.find((entry) => zipEntryKey({ filename: entry.filename }) === ALGORITHM_BUNDLE_MANIFEST)
  if (!manifestEntry) throw new Error("Zip is not a Finny algorithm bundle")
  if (manifestEntry.directory) throw new Error("Zip is not a Finny algorithm bundle")
  if (!manifestEntry.getData) throw new Error("Zip is not a Finny algorithm bundle")
  return manifestEntry as ReadableZipEntry
}

async function readManifestJson(entry: ReadableZipEntry): Promise<unknown> {
  let raw: unknown
  try {
    const data = await entry.getData(new Uint8ArrayWriter(), ZIP_OPTIONS)
    raw = JSON.parse(Buffer.from(data).toString("utf8"))
  } catch {
    throw new Error("Zip is not a Finny algorithm bundle")
  }
  return raw
}

async function loadBundleManifestFromEntries(input: ZipEntriesInput): Promise<BundleManifest> {
  return BundleManifest.parse(await readManifestJson(bundleManifestEntry(input)))
}

async function extractZipEntry(input: ExtractZipEntryInput): Promise<void> {
  const { entry, destDir } = input
  const target = extractTarget({ root: destDir, filename: entry.filename })
  if (entry.directory || entry.filename.endsWith("/")) {
    await fs.mkdir(target, { recursive: true })
    return
  }
  if (!entry.getData) throw new Error(`Unreadable zip entry: ${entry.filename}`)
  const data = await entry.getData(new Uint8ArrayWriter(), ZIP_OPTIONS)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, data)
}

async function extractZipEntries(input: ZipEntriesInput & { destDir: string }): Promise<void> {
  for (const entry of input.entries) {
    await extractZipEntry({ entry, destDir: input.destDir })
  }
}

async function extractBundleZip(input: ExtractBundleZipInput): Promise<BundleManifest> {
  return await readZipEntries({
    zipPath: input.zipPath,
    onEntries: async (entries) => {
      validateZipEntries({ entries })
      const manifest = await loadBundleManifestFromEntries({ entries })
      await extractZipEntries({ entries, destDir: input.destDir })
      return manifest
    },
  })
}

async function findManifestFiles(input: WorkspaceRootInput): Promise<string[]> {
  const result: string[] = []
  async function visit(input: PathInput): Promise<void> {
    const entries = await fs.readdir(input.path, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(input.path, entry.name)
      if (entry.isDirectory()) {
        await visit({ path: fullPath })
        continue
      }
      if (entry.isFile() && entry.name === "manifest.json") result.push(fullPath)
    }
  }
  await visit({ path: input.root })
  return result
}

async function uniqueImportedWorkspacePath(input: ImportedWorkspacePathInput): Promise<string> {
  const base = `${safeBasename({ path: input.basename })}-imported`
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? base : `${base}-${i}`
    const candidate = path.join(input.root, name)
    try {
      await fs.stat(candidate)
    } catch (err: any) {
      if (err?.code === "ENOENT") return candidate
      throw err
    }
  }
  throw new Error(`Unable to find an available imported workspace folder for ${input.basename}`)
}

async function rewriteWorkspaceManifest(input: {
  workspacePath: string
  source: BundleManifest["source"]
  imported: Algorithm.Info
}): Promise<void> {
  const files = await findManifestFiles({ root: input.workspacePath })
  for (const file of files) {
    let raw: any
    try {
      raw = JSON.parse(await fs.readFile(file, "utf8"))
    } catch {
      continue
    }
    if (!Array.isArray(raw.algorithms)) continue

    let changed = false
    raw.algorithms = raw.algorithms.map((entry: any) => {
      if (entry?.algorithmId !== input.source.algorithmId && entry?.name !== input.source.name) return entry
      changed = true
      return {
        ...entry,
        name: input.imported.name,
        algorithmId: input.imported.algorithmId,
        latest_version: input.imported.version,
        store_path: LocalAlgorithmStore.directoryFor(input.imported.algorithmId),
        updated: new Date(input.imported.time_updated).toISOString(),
      }
    })

    if (changed) await fs.writeFile(file, JSON.stringify(raw, null, 2), "utf8")
  }
}

async function importOpenFolderWorkspace(input: {
  extractedRoot: string
  manifest: BundleManifest
  imported: Algorithm.Info
}): Promise<string | undefined> {
  if (input.manifest.openFolder.kind !== "workspace") return undefined

  const basename = assertSafePathSegment({
    value: input.manifest.openFolder.basename,
    label: "Bundle open folder basename",
  })
  const artifacts = finnyHomeArtifacts()
  const source = path.join(input.extractedRoot, "open-folder", basename)
  try {
    const stat = await fs.stat(source)
    if (!stat.isDirectory()) return undefined
  } catch {
    return undefined
  }

  await fs.mkdir(artifacts.algos, { recursive: true })
  const target = await uniqueImportedWorkspacePath({ root: artifacts.algos, basename })
  await fs.cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: false,
  })
  await rewriteWorkspaceManifest({ workspacePath: target, source: input.manifest.source, imported: input.imported })
  return target
}

export async function exportAlgorithmBundle(
  algo: Algorithm.Info,
  destZipPath: string,
): Promise<ExportAlgorithmBundleResult> {
  const zipPath = assertAbsoluteFilePath({ filePath: destZipPath, label: "Export path" })
  const artifacts = finnyHomeArtifacts()
  const storePath = LocalAlgorithmStore.directoryFor(algo.algorithmId)
  const storeStat = await fs.stat(storePath).catch(() => undefined)
  if (!storeStat?.isDirectory()) throw new Error(`No saved algorithm store found for ${algo.name}`)

  const resolved = await resolveAlgorithmFolder({
    algorithmId: algo.algorithmId,
    name: algo.name,
    algosRoot: artifacts.algos,
    algorithmsRoot: artifacts.algorithms,
  })
  if (!resolved.found) throw new Error(`No local folder found for ${algo.name}`)

  const manifest: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source: {
      algorithmId: algo.algorithmId,
      name: algo.name,
      version: algo.version,
    },
    openFolder: {
      kind: resolved.kind,
      basename: safeBasename({ path: resolved.path }),
    },
  }

  const bytes = await writeZip({
    destZipPath: zipPath,
    manifest,
    sections: [
      { sourceDir: resolved.path, zipRoot: `open-folder/${manifest.openFolder.basename}` },
      { sourceDir: storePath, zipRoot: `algorithm-store/${algo.algorithmId}` },
    ],
  })

  return {
    zipPath,
    bytes,
    openFolderKind: resolved.kind,
    openFolderPath: resolved.path,
    storePath,
  }
}

export async function importAlgorithmBundle(
  zipPath: string,
  options: ImportAlgorithmBundleOptions = {},
): Promise<ImportAlgorithmBundleResult> {
  if ((options.conflictPolicy ?? "copy") !== "copy") {
    throw new Error("Only conflictPolicy: copy is supported for algorithm bundle import")
  }
  const sourceZipPath = assertAbsoluteFilePath({ filePath: zipPath, label: "Import path" })
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "finny-algorithm-import-"))

  try {
    const manifest = await extractBundleZip({ zipPath: sourceZipPath, destDir: tempDir })
    const sourceStoreDir = path.join(tempDir, "algorithm-store", manifest.source.algorithmId)
    const userId = await DeviceProfile.userId()
    const imported = (await LocalAlgorithmStore.importCopy({
      sourceDir: sourceStoreDir,
      userId,
    })) as Algorithm.Info
    const copiedWorkspacePath = await importOpenFolderWorkspace({
      extractedRoot: tempDir,
      manifest,
      imported,
    })

    return { algorithm: imported, copiedWorkspacePath }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
