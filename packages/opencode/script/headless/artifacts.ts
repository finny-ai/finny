import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { RunManifestV1, type RunManifestV1 as RunManifest } from "./types"

export function sha256Bytes(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export async function sha256File(input: { file: string }): Promise<string> {
  return sha256Bytes(await fs.readFile(input.file))
}

type ListFilesInput = {
  root: string
  current?: string
}

async function listFiles(input: ListFilesInput): Promise<string[]> {
  const current = input.current ?? input.root
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles({ root: input.root, current: absolute })))
    else if (entry.isFile()) files.push(path.relative(input.root, absolute))
  }
  return files.sort()
}

export async function hashTree(input: { root: string }): Promise<string> {
  const entries: string[] = []
  for (const relative of await listFiles({ root: input.root })) {
    const digest = await sha256File({ file: path.join(input.root, relative) })
    entries.push(`${digest}  ${relative}`)
  }
  return sha256Bytes(entries.join("\n"))
}

export type BundleWriter = {
  outputDir: string
  runId: string
  stagingDir: string
  finalDir: string
}

export async function createBundleWriter(input: { outputDir: string; runId: string }): Promise<BundleWriter> {
  await fs.mkdir(input.outputDir, { recursive: true })
  const stagingDir = path.join(input.outputDir, `.${input.runId}.tmp`)
  const finalDir = path.join(input.outputDir, input.runId)
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(path.join(stagingDir, "raw"), { recursive: true })
  await fs.mkdir(path.join(stagingDir, "objects", "sha256"), { recursive: true })
  return { outputDir: input.outputDir, runId: input.runId, stagingDir, finalDir }
}

export async function writeBundleText(input: {
  writer: BundleWriter
  relative: string
  content: string
}): Promise<void> {
  const file = path.join(input.writer.stagingDir, input.relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, input.content, "utf8")
}

export async function addContentAddressedArtifact(input: {
  writer: BundleWriter
  source: string
  kind: string
}): Promise<{ path: string; sha256: string; size: number; kind: string }> {
  const bytes = await fs.readFile(input.source)
  const digest = sha256Bytes(bytes)
  const relative = path.join("objects", "sha256", digest)
  const destination = path.join(input.writer.stagingDir, relative)
  await fs.writeFile(destination, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  return { path: relative, sha256: digest, size: bytes.byteLength, kind: input.kind }
}

function renderSummary(manifest: RunManifest): string {
  const lines = [
    `# Finny headless harness: ${manifest.scenarioId}`,
    "",
    `- Run: ${manifest.runId}`,
    `- Status: ${manifest.status}`,
    `- Exit code: ${manifest.exitCode}`,
    `- Source: ${manifest.source.commit}`,
    `- Agent/model: ${manifest.model.agent} / ${manifest.model.id}`,
    `- Duration: ${(manifest.durationMs / 1000).toFixed(2)}s`,
    `- Contract violations: ${manifest.requestAdherence.violations.length}`,
    `- Errors: ${manifest.errors.length}`,
    "",
  ]
  if (manifest.requestAdherence.violations.length) {
    lines.push("## Contract violations", "")
    for (const violation of manifest.requestAdherence.violations) lines.push(`- ${violation.code}: ${violation.message}`)
    lines.push("")
  }
  if (manifest.errors.length) {
    lines.push("## Errors", "")
    for (const error of manifest.errors) lines.push(`- ${error.kind}: ${error.message}`)
    lines.push("")
  }
  return lines.join("\n")
}

async function collectArtifactEntries(writer: BundleWriter): Promise<RunManifest["artifacts"]> {
  const artifacts: RunManifest["artifacts"] = []
  for (const relative of await listFiles({ root: writer.stagingDir })) {
    if (relative === "run-manifest.json" || relative === "checksums.sha256" || relative === "summary.md") continue
    const absolute = path.join(writer.stagingDir, relative)
    const stat = await fs.stat(absolute)
    artifacts.push({
      path: relative,
      sha256: await sha256File({ file: absolute }),
      size: stat.size,
      kind: relative.startsWith("raw/") ? "raw" : "object",
    })
  }
  return artifacts
}

function artifactMerkleRoot(artifacts: RunManifest["artifacts"]): string {
  return sha256Bytes(
    artifacts
      .map((artifact) => `${artifact.sha256}  ${artifact.path}`)
      .sort()
      .join("\n"),
  )
}

async function writeChecksums(writer: BundleWriter): Promise<void> {
  const checksums: string[] = []
  for (const relative of await listFiles({ root: writer.stagingDir })) {
    if (relative === "checksums.sha256") continue
    const digest = await sha256File({ file: path.join(writer.stagingDir, relative) })
    checksums.push(`${digest}  ${relative}`)
  }
  await writeBundleText({ writer, relative: "checksums.sha256", content: checksums.sort().join("\n") + "\n" })
}

export async function publishBundle(writer: BundleWriter, base: Omit<RunManifest, "artifacts" | "integrity">) {
  const artifacts = await collectArtifactEntries(writer)
  const manifest = RunManifestV1.parse({
    ...base,
    artifacts,
    integrity: { artifactMerkleRoot: artifactMerkleRoot(artifacts), checksumAlgorithm: "sha256" },
  })
  await writeBundleText({ writer, relative: "run-manifest.json", content: JSON.stringify(manifest, null, 2) + "\n" })
  await writeBundleText({ writer, relative: "summary.md", content: renderSummary(manifest) })
  await writeChecksums(writer)
  await fs.rename(writer.stagingDir, writer.finalDir)
  return { manifest, bundlePath: writer.finalDir }
}
