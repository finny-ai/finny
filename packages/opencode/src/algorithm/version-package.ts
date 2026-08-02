import crypto from "node:crypto"
import type { Stats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import {
  BlobReader,
  BlobWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
  configure,
} from "@zip.js/zip.js"
import z from "zod"
import { LocalAlgorithmStore } from "@/storage/local/algorithm-store"
import { DeviceProfile } from "@/device"

const ZIP_OPTIONS = { useWebWorkers: false } as const
configure(ZIP_OPTIONS)

export const VERSION_PACKAGE_MANIFEST = "finny-algorithm-version.json"
export const VERSION_PACKAGE_SCHEMA = "finny.algorithm_version_package"
export const VERSION_FILE_ALLOWLIST = [
  "strategy.py",
  "config.json",
  "reasoning.md",
  "mission.md",
  "prefs.md",
  "decisions.md",
  "risk.json",
  "backtest.py",
] as const

const REQUIRED_FILES = new Set<string>(VERSION_FILE_ALLOWLIST.filter((file) => file !== "backtest.py"))
const ALLOWED_FILES = new Set<string>(VERSION_FILE_ALLOWLIST)
export const VERSION_MAX_ENTRIES = VERSION_FILE_ALLOWLIST.length + 1
export const VERSION_MAX_ENTRY_BYTES = 16 * 1024 * 1024
export const VERSION_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z")

const FileRecord = z.object({
  path: z.enum(VERSION_FILE_ALLOWLIST),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative().max(VERSION_MAX_ENTRY_BYTES),
})

export const Manifest = z.object({
  schema: z.literal(VERSION_PACKAGE_SCHEMA),
  schemaVersion: z.literal(1),
  algorithmId: z.string().min(1),
  version: z.number().int().positive(),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(FileRecord).min(REQUIRED_FILES.size).max(VERSION_FILE_ALLOWLIST.length),
})
export type Manifest = z.infer<typeof Manifest>

export interface BuiltPackage {
  archive: Uint8Array
  archiveSha256: string
  manifest: Manifest
}

export interface VerifiedPackage extends BuiltPackage {
  files: ReadonlyMap<string, Uint8Array>
}

export const CatalogMetadata = z.object({
  algorithmId: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),
  language: z.string().min(1),
  status: z.string().min(1),
  description: z.string().optional(),
  brokerKind: z.string().trim().min(1).max(128).optional(),
  targetBrokerage: z.string().trim().min(1).max(128).optional(),
  timeCreated: z.number().finite(),
  timeUpdated: z.number().finite(),
})
export type CatalogMetadata = z.infer<typeof CatalogMetadata>

interface ZipEntryLike {
  filename: string
  directory?: boolean
  uncompressedSize?: number
  getData?: (writer: Uint8ArrayWriter, options?: typeof ZIP_OPTIONS) => Promise<Uint8Array>
}

type VersionFileName = (typeof VERSION_FILE_ALLOWLIST)[number]

interface PackageIdentity {
  algorithmId: string
  version: number
}

interface CanonicalFile {
  filename: VersionFileName
  file: string
  bytes: number
}

function sha256(bytes: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`
}

function payloadHash(files: Manifest["files"]): string {
  return sha256(stableStringify(files))
}

const SAFE_ALGORITHM_ID_CHECKS: ReadonlyArray<(value: string) => boolean> = [
  (value) => value.length > 0,
  (value) => value !== ".",
  (value) => value !== "..",
  (value) => !/[\\/\0]/.test(value),
]

function isSafeAlgorithmIdSegment(value: string): boolean {
  return SAFE_ALGORITHM_ID_CHECKS.every((check) => check(value))
}

function isPositiveVersion(value: number): boolean {
  if (!Number.isSafeInteger(value)) return false
  return value >= 1
}

function assertIdentity(identity: PackageIdentity): void {
  if (!isSafeAlgorithmIdSegment(identity.algorithmId)) throw new Error("algorithmId must be a safe path segment")
  if (!isPositiveVersion(identity.version)) throw new Error("version must be a positive integer")
}

function versionTag(version: number): string {
  return `v${String(version).padStart(2, "0")}`
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function canonicalFileStat(input: { file: string; filename: VersionFileName }): Promise<Stats | undefined> {
  return fs.lstat(input.file).catch((error: unknown) => {
    if (!isMissingFileError(error)) throw error
    if (REQUIRED_FILES.has(input.filename)) throw new Error(`Canonical version is missing ${input.filename}`)
    return undefined
  })
}

function assertCanonicalFileStat(input: { filename: VersionFileName; stat: Stats }): void {
  if (input.stat.isSymbolicLink() || !input.stat.isFile()) {
    throw new Error(`Canonical version entry must be a regular file: ${input.filename}`)
  }
  if (input.stat.size > VERSION_MAX_ENTRY_BYTES) {
    throw new Error(`Canonical version entry is too large: ${input.filename}`)
  }
}

async function inspectCanonicalFile(input: {
  directory: string
  filename: VersionFileName
}): Promise<CanonicalFile | undefined> {
  const file = path.join(input.directory, input.filename)
  const stat = await canonicalFileStat({ file, filename: input.filename })
  if (!stat) return undefined
  assertCanonicalFileStat({ filename: input.filename, stat })
  return { filename: input.filename, file, bytes: stat.size }
}

async function collectCanonicalFiles(input: PackageIdentity): Promise<CanonicalFile[]> {
  assertIdentity(input)
  const directory = path.join(LocalAlgorithmStore.directoryFor(input.algorithmId), versionTag(input.version))
  const files: CanonicalFile[] = []
  let totalBytes = 0
  for (const filename of VERSION_FILE_ALLOWLIST) {
    const file = await inspectCanonicalFile({ directory, filename })
    if (!file) continue
    totalBytes += file.bytes
    if (totalBytes > VERSION_MAX_TOTAL_BYTES) throw new Error("Canonical version exceeds maximum total size")
    files.push(file)
  }
  return files
}

async function readCanonicalFiles(entries: CanonicalFile[]): Promise<Map<string, Uint8Array>> {
  const result = new Map<string, Uint8Array>()
  for (const entry of entries) {
    const bytes = new Uint8Array(await fs.readFile(entry.file))
    if (bytes.length !== entry.bytes) {
      throw new Error(`Canonical version entry changed while reading: ${entry.filename}`)
    }
    result.set(entry.filename, bytes)
  }
  return result
}

async function canonicalFiles(input: PackageIdentity): Promise<Map<string, Uint8Array>> {
  return readCanonicalFiles(await collectCanonicalFiles(input))
}

export async function createArchive(entries: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const [filename, bytes] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    await writer.add(filename, new Uint8ArrayReader(bytes), {
      ...ZIP_OPTIONS,
      compressionMethod: 0,
      lastModDate: FIXED_ZIP_DATE,
      extendedTimestamp: false,
    })
  }
  const blob = await writer.close()
  return new Uint8Array(await blob.arrayBuffer())
}

export async function build(input: { algorithmId: string; version: number }): Promise<BuiltPackage> {
  const files = await canonicalFiles(input)
  const records = [...files]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filename, bytes]) => ({
      path: filename as (typeof VERSION_FILE_ALLOWLIST)[number],
      sha256: sha256(bytes),
      bytes: bytes.length,
    }))
  const manifest: Manifest = {
    schema: VERSION_PACKAGE_SCHEMA,
    schemaVersion: 1,
    algorithmId: input.algorithmId,
    version: input.version,
    payloadHash: payloadHash(records),
    files: records,
  }
  const entries = new Map(files)
  const manifestBytes = new TextEncoder().encode(`${stableStringify(manifest)}\n`)
  if (manifestBytes.length > VERSION_MAX_ENTRY_BYTES) throw new Error("Canonical version manifest is too large")
  const totalBytes = records.reduce((total, file) => total + file.bytes, manifestBytes.length)
  if (totalBytes > VERSION_MAX_TOTAL_BYTES) throw new Error("Canonical version exceeds maximum total size")
  entries.set(VERSION_PACKAGE_MANIFEST, manifestBytes)
  const archive = await createArchive(entries)
  return { archive, archiveSha256: sha256(archive), manifest }
}

const INVALID_PATH_PARTS = new Set(["", ".", ".."])
const SAFE_ENTRY_NAME_CHECKS: ReadonlyArray<(filename: string) => boolean> = [
  (filename) => filename.length > 0,
  (filename) => !filename.includes("\\"),
  (filename) => !path.posix.isAbsolute(filename),
  (filename) => !/^[A-Za-z]:/.test(filename),
  (filename) => path.posix.normalize(filename) === filename,
  (filename) => !filename.split("/").some((part) => INVALID_PATH_PARTS.has(part)),
]

function assertSafeEntryName(filename: string): void {
  const safe = SAFE_ENTRY_NAME_CHECKS.every((check) => check(filename))
  if (!safe) throw new Error(`Unsafe package entry path: ${filename}`)
}

function isValidEntrySize(size: unknown): size is number {
  if (typeof size !== "number") return false
  if (!Number.isSafeInteger(size)) return false
  return size >= 0
}

function entrySize(entry: ZipEntryLike): number {
  const size = entry.uncompressedSize
  if (!isValidEntrySize(size)) throw new Error(`Invalid package entry size: ${entry.filename}`)
  return size
}

async function readEntry(entry: ZipEntryLike): Promise<Uint8Array> {
  if (!entry.getData) throw new Error(`Unreadable package entry: ${entry.filename}`)
  const bytes = await entry.getData(new Uint8ArrayWriter(), ZIP_OPTIONS)
  if (bytes.length !== entrySize(entry)) throw new Error(`Package entry size changed while reading: ${entry.filename}`)
  return bytes
}

function assertArchiveEntryAllowed(entry: ZipEntryLike): void {
  assertSafeEntryName(entry.filename)
  if (entry.directory || entry.filename.endsWith("/")) {
    throw new Error(`Directories are not allowed in a version package: ${entry.filename}`)
  }
  if (entry.filename !== VERSION_PACKAGE_MANIFEST && !ALLOWED_FILES.has(entry.filename)) {
    throw new Error(`Unknown package entry: ${entry.filename}`)
  }
}

function addArchiveEntry(entriesByName: Map<string, ZipEntryLike>, entry: ZipEntryLike): number {
  assertArchiveEntryAllowed(entry)
  if (entriesByName.has(entry.filename)) throw new Error(`Duplicate package entry: ${entry.filename}`)
  const size = entrySize(entry)
  if (size > VERSION_MAX_ENTRY_BYTES) throw new Error(`Package entry is too large: ${entry.filename}`)
  entriesByName.set(entry.filename, entry)
  return size
}

function collectZipEntries(entries: ZipEntryLike[]): Map<string, ZipEntryLike> {
  const entriesByName = new Map<string, ZipEntryLike>()
  let totalBytes = 0
  for (const entry of entries) {
    totalBytes += addArchiveEntry(entriesByName, entry)
    if (totalBytes > VERSION_MAX_TOTAL_BYTES) throw new Error("Package exceeds maximum uncompressed size")
  }
  if (entries.length > VERSION_MAX_ENTRIES) throw new Error(`Package has too many entries: ${entries.length}`)
  return entriesByName
}

async function readPackageManifest(entriesByName: ReadonlyMap<string, ZipEntryLike>): Promise<Manifest> {
  const entry = entriesByName.get(VERSION_PACKAGE_MANIFEST)
  if (!entry) throw new Error(`Package is missing ${VERSION_PACKAGE_MANIFEST}`)
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(await readEntry(entry)))
  } catch {
    throw new Error("Package manifest is not valid JSON")
  }
  const manifest = Manifest.parse(raw)
  assertIdentity(manifest)
  return manifest
}

function assertManifestFilesSorted(manifest: Manifest): void {
  const sorted = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path))
  if (stableStringify(sorted) !== stableStringify(manifest.files)) {
    throw new Error("Package manifest files are not sorted")
  }
}

function assertManifestFilesUnique(manifest: Manifest): void {
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) {
    throw new Error("Package manifest contains duplicate files")
  }
}

function assertManifestHasRequiredFiles(manifest: Manifest): void {
  const declaredFiles = new Set<string>(manifest.files.map((file) => file.path))
  for (const required of REQUIRED_FILES) {
    if (!declaredFiles.has(required)) throw new Error(`Package manifest is missing ${required}`)
  }
}

function validateManifestFiles(manifest: Manifest): void {
  assertManifestFilesSorted(manifest)
  assertManifestFilesUnique(manifest)
  assertManifestHasRequiredFiles(manifest)
  if (manifest.payloadHash !== payloadHash(manifest.files)) throw new Error("Package payload hash mismatch")
}

async function readVerifiedPayloadFile(
  record: Manifest["files"][number],
  entriesByName: ReadonlyMap<string, ZipEntryLike>,
): Promise<Uint8Array> {
  const entry = entriesByName.get(record.path)
  if (!entry) throw new Error(`Package is missing declared file: ${record.path}`)
  const bytes = await readEntry(entry)
  if (bytes.length !== record.bytes) throw new Error(`Package byte count mismatch: ${record.path}`)
  if (sha256(bytes) !== record.sha256) throw new Error(`Package file hash mismatch: ${record.path}`)
  return bytes
}

async function readVerifiedPayloadFiles(
  manifest: Manifest,
  entriesByName: ReadonlyMap<string, ZipEntryLike>,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  for (const record of manifest.files) {
    files.set(record.path, await readVerifiedPayloadFile(record, entriesByName))
  }
  return files
}

export async function verify(archive: Uint8Array): Promise<VerifiedPackage> {
  const reader = new ZipReader(new BlobReader(new Blob([Uint8Array.from(archive).buffer])), ZIP_OPTIONS)
  try {
    const entriesByName = collectZipEntries(await reader.getEntries())
    const manifest = await readPackageManifest(entriesByName)
    validateManifestFiles(manifest)
    if (entriesByName.size !== manifest.files.length + 1) throw new Error("Package entries do not match its manifest")
    const files = await readVerifiedPayloadFiles(manifest, entriesByName)
    return { archive, archiveSha256: sha256(archive), manifest, files }
  } finally {
    await reader.close().catch(() => undefined)
  }
}

export async function materialize(input: { archive: Uint8Array; catalog: CatalogMetadata }) {
  const verified = await verify(input.archive)
  const catalog = CatalogMetadata.parse(input.catalog)
  if (verified.manifest.algorithmId !== catalog.algorithmId || verified.manifest.version !== catalog.version) {
    throw new Error("Catalog identity does not match the version package")
  }
  return LocalAlgorithmStore.materializeCanonicalVersion({
    catalog,
    userId: await DeviceProfile.userId(),
    package: verified,
  })
}

export * as AlgorithmVersionPackage from "./version-package"
