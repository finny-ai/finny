import { homedir } from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { ALGO_NAME_RE, VERSION_DIR_RE } from "./schemas"

const TEMPLATE_DIR = "_template"

export function algosRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA
    if (local && local.length > 0) return path.join(local, "finny", "algos")
    return path.join(homedir(), "AppData", "Local", "finny", "algos")
  }
  const xdg = env.XDG_DATA_HOME
  if (xdg && xdg.length > 0) return path.join(xdg, "finny", "algos")
  return path.join(homedir(), ".local", "share", "finny", "algos")
}

export function algoDir(name: string, root: string = algosRoot()): string {
  if (!ALGO_NAME_RE.test(name)) {
    throw new Error(`invalid algo name: ${JSON.stringify(name)} (must be kebab-case)`)
  }
  return path.join(root, name)
}

export function versionDir(name: string, version: string, root: string = algosRoot()): string {
  return path.join(algoDir(name, root), version)
}

export function archiveDir(name: string, root: string = algosRoot()): string {
  return path.join(algoDir(name, root), ".archive")
}

export async function discoverAlgos(root: string = algosRoot()): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === "ENOENT") return []
    throw err
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== TEMPLATE_DIR && !e.name.startsWith(".") && ALGO_NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort()
}

export async function discoverVersions(name: string, root: string = algosRoot()): Promise<string[]> {
  const dir = algoDir(name, root)
  let entries: import("node:fs").Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err: any) {
    if (err?.code === "ENOENT") return []
    throw err
  }
  // Zero-padded vNN sorts lexicographically.
  return entries
    .filter((e) => e.isDirectory() && VERSION_DIR_RE.test(e.name))
    .map((e) => e.name)
    .sort()
}
