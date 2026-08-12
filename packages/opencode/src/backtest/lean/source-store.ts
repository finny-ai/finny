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

/**
 * The exact files Finny holds for one algorithm version, ordered by path.
 * Falls back to `algorithm.code` (main.py / Main.cs) for candidates saved
 * before the LEAN source store existed, mirroring the QC sync layer.
 */
export async function sourceFilesForAlgorithm(
  algorithm: Pick<Algorithm.Info, "algorithmId" | "version" | "code" | "language">,
): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const root = leanSourceRoot(algorithm)
  const files: Array<{ path: string; sha256: string; bytes: number }> = []
  let entries: string[] = []
  try {
    entries = await fs.readdir(root, { recursive: true })
  } catch {
    entries = []
  }
  for (const relative of entries.filter((entry) => !entry.startsWith("."))) {
    const full = path.join(root, relative)
    let stat
    try {
      stat = await fs.stat(full)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const content = await fs.readFile(full, "utf8")
    files.push({
      path: relative.split(path.sep).join("/"),
      sha256: sha256Text(content),
      bytes: Buffer.byteLength(content, "utf8"),
    })
  }
  if (files.length === 0 && typeof algorithm.code === "string" && algorithm.code.length > 0) {
    const mainName = algorithm.language === "csharp" ? "Main.cs" : "main.py"
    files.push({
      path: mainName,
      sha256: sha256Text(algorithm.code),
      bytes: Buffer.byteLength(algorithm.code, "utf8"),
    })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}
