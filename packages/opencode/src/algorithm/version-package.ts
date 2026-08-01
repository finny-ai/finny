import crypto from "node:crypto"
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

function assertIdentity(algorithmId: string, version: number): void {
  if (!algorithmId || algorithmId === "." || algorithmId === ".." || /[\\/\0]/.test(algorithmId)) {
    throw new Error("algorithmId must be a safe path segment")
  }
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("version must be a positive integer")
}

function versionTag(version: number): string {
  return `v${String(version).padStart(2, "0")}`
}

async function canonicalFiles(input: { algorithmId: string; version: number }): Promise<Map<string, Uint8Array>> {
  assertIdentity(input.algorithmId, input.version)
  const dir = path.join(LocalAlgorithmStore.directoryFor(input.algorithmId), versionTag(input.version))
  const paths: Array<{ filename: string; file: string; bytes: number }> = []
  let total = 0
  for (const filename of VERSION_FILE_ALLOWLIST) {
    const file = path.join(dir, filename)
    let stat: Awaited<ReturnType<typeof fs.lstat>>
    try {
      stat = await fs.lstat(file)
    } catch (error: any) {
      if (error?.code === "ENOENT" && !REQUIRED_FILES.has(filename)) continue
      if (error?.code === "ENOENT") throw new Error(`Canonical version is missing ${filename}`)
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Canonical version entry must be a regular file: ${filename}`)
    }
    if (stat.size > VERSION_MAX_ENTRY_BYTES) throw new Error(`Canonical version entry is too large: ${filename}`)
    total += stat.size
    if (total > VERSION_MAX_TOTAL_BYTES) throw new Error("Canonical version exceeds maximum total size")
    paths.push({ filename, file, bytes: stat.size })
  }

  const result = new Map<string, Uint8Array>()
  for (const entry of paths) {
    const bytes = new Uint8Array(await fs.readFile(entry.file))
    if (bytes.length !== entry.bytes)
      throw new Error(`Canonical version entry changed while reading: ${entry.filename}`)
    result.set(entry.filename, bytes)
  }
  return result
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

function assertSafeEntryName(filename: string): void {
  if (
    !filename ||
    filename.includes("\\") ||
    filename.startsWith("/") ||
    /^[A-Za-z]:/.test(filename) ||
    filename.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path.posix.normalize(filename) !== filename
  ) {
    throw new Error(`Unsafe package entry path: ${filename}`)
  }
}

function entrySize(entry: ZipEntryLike): number {
  const size = entry.uncompressedSize
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Invalid package entry size: ${entry.filename}`)
  }
  return size
}

async function readEntry(entry: ZipEntryLike): Promise<Uint8Array> {
  if (!entry.getData) throw new Error(`Unreadable package entry: ${entry.filename}`)
  const bytes = await entry.getData(new Uint8ArrayWriter(), ZIP_OPTIONS)
  if (bytes.length !== entrySize(entry)) throw new Error(`Package entry size changed while reading: ${entry.filename}`)
  return bytes
}

export async function verify(archive: Uint8Array): Promise<VerifiedPackage> {
  const reader = new ZipReader(new BlobReader(new Blob([Uint8Array.from(archive).buffer])), ZIP_OPTIONS)
  let entries: ZipEntryLike[]
  try {
    entries = await reader.getEntries()
    const seen = new Set<string>()
    let total = 0
    for (const entry of entries) {
      assertSafeEntryName(entry.filename)
      if (entry.directory || entry.filename.endsWith("/"))
        throw new Error(`Directories are not allowed in a version package: ${entry.filename}`)
      if (seen.has(entry.filename)) throw new Error(`Duplicate package entry: ${entry.filename}`)
      seen.add(entry.filename)
      if (entry.filename !== VERSION_PACKAGE_MANIFEST && !ALLOWED_FILES.has(entry.filename)) {
        throw new Error(`Unknown package entry: ${entry.filename}`)
      }
      const size = entrySize(entry)
      if (size > VERSION_MAX_ENTRY_BYTES) throw new Error(`Package entry is too large: ${entry.filename}`)
      total += size
      if (total > VERSION_MAX_TOTAL_BYTES) throw new Error("Package exceeds maximum uncompressed size")
    }
    if (entries.length > VERSION_MAX_ENTRIES) throw new Error(`Package has too many entries: ${entries.length}`)

    const manifestEntry = entries.find((entry) => entry.filename === VERSION_PACKAGE_MANIFEST)
    if (!manifestEntry) throw new Error(`Package is missing ${VERSION_PACKAGE_MANIFEST}`)
    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(new TextDecoder().decode(await readEntry(manifestEntry)))
    } catch {
      throw new Error("Package manifest is not valid JSON")
    }
    const manifest = Manifest.parse(rawManifest)
    assertIdentity(manifest.algorithmId, manifest.version)
    const sorted = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path))
    if (stableStringify(sorted) !== stableStringify(manifest.files))
      throw new Error("Package manifest files are not sorted")
    if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) {
      throw new Error("Package manifest contains duplicate files")
    }
    for (const required of REQUIRED_FILES) {
      if (!manifest.files.some((file) => file.path === required))
        throw new Error(`Package manifest is missing ${required}`)
    }
    if (manifest.payloadHash !== payloadHash(manifest.files)) throw new Error("Package payload hash mismatch")
    if (entries.length !== manifest.files.length + 1) throw new Error("Package entries do not match its manifest")

    const files = new Map<string, Uint8Array>()
    for (const record of manifest.files) {
      const entry = entries.find((candidate) => candidate.filename === record.path)
      if (!entry) throw new Error(`Package is missing declared file: ${record.path}`)
      const bytes = await readEntry(entry)
      if (bytes.length !== record.bytes) throw new Error(`Package byte count mismatch: ${record.path}`)
      if (sha256(bytes) !== record.sha256) throw new Error(`Package file hash mismatch: ${record.path}`)
      files.set(record.path, bytes)
    }
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
