import fs from "node:fs/promises"
import path from "node:path"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import type { Algorithm } from "@/algorithm"
import { sha256Text } from "./contracts"

/**
 * Durable storage for LEAN strategy source trees. Files live under the
 * algorithm version directory so every saved version carries its own exact
 * source bytes, and the run identity can hash them.
 */
function leanSourceRoot(algorithm: Pick<Algorithm.Info, "algorithmId" | "version">): string {
  const id = algorithm.algorithmId
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) throw new Error("invalid algorithmId for LEAN source store")
  return path.join(finnyArtifactPath("algorithms"), id, `v${String(algorithm.version).padStart(2, "0")}`, "source")
}

export async function writeLeanSourceFile(input: {
  algorithm: Pick<Algorithm.Info, "algorithmId" | "version">
  relativePath: string
  content: string
}): Promise<{ path: string; sha256: string; bytes: number }> {
  if (input.relativePath.startsWith("/") || input.relativePath.includes("\\") || input.relativePath.includes("..")) {
    throw new Error(`unsafe LEAN source path: ${input.relativePath}`)
  }
  const dir = leanSourceRoot(input.algorithm)
  const file = path.join(dir, input.relativePath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, input.content, "utf8")
  return { path: input.relativePath, sha256: sha256Text(input.content), bytes: Buffer.byteLength(input.content, "utf8") }
}

export async function readLeanSourceFile(input: {
  algorithm: Pick<Algorithm.Info, "algorithmId" | "version">
  relativePath: string
}): Promise<string> {
  const file = path.join(leanSourceRoot(input.algorithm), input.relativePath)
  return fs.readFile(file, "utf8")
}

export async function leanSourceDir(input: Pick<Algorithm.Info, "algorithmId" | "version">): Promise<string> {
  return leanSourceRoot(input)
}
