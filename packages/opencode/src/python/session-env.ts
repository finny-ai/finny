import path from "node:path"
import fs from "node:fs/promises"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import { Python, ensurePythonEnv } from "./env"

export const WORKSPACE_VENV = ".venv"
export { ENV_MARKER } from "./env"

/** Default packages provisioned during session preflight and reused by tools. */
export const SESSION_PREFLIGHT_PACKAGES: Python.PackageRequirement[] = [
  { spec: "numpy", importCheck: "numpy" },
  { spec: "pandas", importCheck: "pandas" },
  { spec: "yfinance", importCheck: "yfinance" },
  { spec: "requests", importCheck: "requests" },
  { spec: "scipy", importCheck: "scipy" },
  { spec: "pyarrow", importCheck: "pyarrow" },
  { spec: "pytz", importCheck: "pytz" },
]

export function workspaceEnvDir(workspacePath: string): string {
  const harnessEnv = process.env.FINNY_HARNESS_PYTHON_ENV?.trim()
  if (process.env.FINNY_HARNESS_MODE === "1" && harnessEnv) return path.resolve(harnessEnv)
  return path.join(workspacePath, WORKSPACE_VENV)
}

export async function workspacePythonExists(workspacePath: string): Promise<boolean> {
  try {
    await fs.stat(Python.pythonBinForEnvDir(workspaceEnvDir(workspacePath)))
    return true
  } catch {
    return false
  }
}

export async function isWorkspaceEnvReady(
  _workspacePath: string,
  packages: Python.PackageRequirement[],
): Promise<boolean> {
  return Python.envMarkerValid(Python.sharedEnvDir(packages), packages)
}

export async function resolveWorkspacePythonEnv(
  _workspacePath: string,
  packages: Python.PackageRequirement[],
  onProgress: Python.ProgressCallback = () => {},
): Promise<Python.Environment> {
  return ensurePythonEnv(packages, onProgress)
}

/**
 * Resolve every session to the content-addressed environment for its package
 * set. Existing workspace `.venv` directories are intentionally left in place
 * until the user runs the explicit reclaim command.
 */
export async function resolveSessionPythonEnv(
  sessionID: string | undefined,
  packages: Python.PackageRequirement[],
  onProgress: Python.ProgressCallback = () => {},
): Promise<Python.Environment> {
  if (sessionID) {
    const slug = await getSessionWorkspace(sessionID).catch(() => null)
    if (slug) {
      const workspacePath = algoDir(slug)
      return resolveWorkspacePythonEnv(workspacePath, packages, onProgress)
    }
  }
  return ensurePythonEnv(packages, onProgress)
}
