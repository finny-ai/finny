// @codescene(disable-all) Artifact serialization keeps the published hash contract together.
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { RunManifestV1, type RunManifestV1 as RunManifest } from "./types"

export function sha256Bytes(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

export async function sha256File(file: string): Promise<string> {
  return sha256Bytes(await fs.readFile(file))
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const absolute = path.join(current, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(root, absolute)))
    else if (entry.isFile()) files.push(path.relative(root, absolute))
  }
  return files.sort()
}

export async function hashTree(root: string): Promise<string> {
  const entries: string[] = []
  for (const relative of await listFiles(root)) {
    entries.push(`${await sha256File(path.join(root, relative))}  ${relative}`)
  }
  return sha256Bytes(entries.join("\n"))
}

export type BundleWriter = {
  outputDir: string
  runId: string
  stagingDir: string
  finalDir: string
}

export async function createBundleWriter(outputDir: string, runId: string): Promise<BundleWriter> {
  await fs.mkdir(outputDir, { recursive: true })
  const stagingDir = path.join(outputDir, `.${runId}.tmp`)
  const finalDir = path.join(outputDir, runId)
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(path.join(stagingDir, "raw"), { recursive: true })
  await fs.mkdir(path.join(stagingDir, "objects", "sha256"), { recursive: true })
  return { outputDir, runId, stagingDir, finalDir }
}

export async function writeBundleText(writer: BundleWriter, relative: string, content: string): Promise<void> {
  const file = path.join(writer.stagingDir, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf8")
}

export async function addContentAddressedArtifact(
  writer: BundleWriter,
  source: string,
  kind: string,
): Promise<{ path: string; sha256: string; size: number; kind: string }> {
  const bytes = await fs.readFile(source)
  const sha256 = sha256Bytes(bytes)
  const relative = path.join("objects", "sha256", sha256)
  const destination = path.join(writer.stagingDir, relative)
  await fs.writeFile(destination, bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  return { path: relative, sha256, size: bytes.byteLength, kind }
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

export async function publishBundle(writer: BundleWriter, base: Omit<RunManifest, "artifacts" | "integrity">) {
  const artifacts: RunManifest["artifacts"] = []
  for (const relative of await listFiles(writer.stagingDir)) {
    if (relative === "run-manifest.json" || relative === "checksums.sha256" || relative === "summary.md") continue
    const absolute = path.join(writer.stagingDir, relative)
    const stat = await fs.stat(absolute)
    artifacts.push({ path: relative, sha256: await sha256File(absolute), size: stat.size, kind: relative.startsWith("raw/") ? "raw" : "object" })
  }
  const artifactMerkleRoot = sha256Bytes(
    artifacts
      .map((artifact) => `${artifact.sha256}  ${artifact.path}`)
      .sort()
      .join("\n"),
  )
  const manifest = RunManifestV1.parse({
    ...base,
    artifacts,
    integrity: { artifactMerkleRoot, checksumAlgorithm: "sha256" },
  })
  await writeBundleText(writer, "run-manifest.json", JSON.stringify(manifest, null, 2) + "\n")
  await writeBundleText(writer, "summary.md", renderSummary(manifest))

  const checksums: string[] = []
  for (const relative of await listFiles(writer.stagingDir)) {
    if (relative === "checksums.sha256") continue
    checksums.push(`${await sha256File(path.join(writer.stagingDir, relative))}  ${relative}`)
  }
  await writeBundleText(writer, "checksums.sha256", checksums.sort().join("\n") + "\n")
  await fs.rename(writer.stagingDir, writer.finalDir)
  return { manifest, bundlePath: writer.finalDir }
}
