// @codescene(disable-all) Managed Python env path/installer surface is intentionally string-heavy.
import fs from "fs/promises"
import path from "path"
import { Process } from "@/util/process"
import { Log } from "@/util/log"
import { Global } from "@/global"
import { finnyArtifactPath } from "@finny-ai/core/prefs"

const log = Log.create({ service: "python.env" })
const IS_WIN = process.platform === "win32"
export const ENV_MARKER = ".finny-env-ready.json"

/**
 * Managed Python venv shared across the live runner and the backtest runner.
 * One venv lives at `$FINNY_HOME/python-env`; callers declare the
 * packages they need and {@link ensurePythonEnv} installs anything missing.
 *
 * Per-workspace envs use {@link ensurePythonEnvAt} with `<workspace>/.venv`.
 */
export namespace Python {
  export interface PackageRequirement {
    /** pip spec, e.g. "yfinance" or "alpaca-py>=0.13". */
    spec: string
    /** Python module name to probe with `import <name>` after install. */
    importCheck: string
  }

  export interface EnvMarker {
    installer: "uv" | "pip"
    python: string
    packages: PackageRequirement[]
    verifiedAt: string
  }

  export type ProgressCallback = (message: string) => void

  export interface Environment {
    python: string
    pip: string
    envDir: string
  }

  export function pythonBinForEnvDir(envDir: string): string {
    return IS_WIN ? path.join(envDir, "Scripts", "python.exe") : path.join(envDir, "bin", "python")
  }

  export function pipBinForEnvDir(envDir: string): string {
    return IS_WIN ? path.join(envDir, "Scripts", "pip.exe") : path.join(envDir, "bin", "pip")
  }

  export function managedEnvDir(): string {
    const harnessEnv = process.env.FINNY_HARNESS_PYTHON_ENV?.trim()
    if (process.env.FINNY_HARNESS_MODE === "1" && harnessEnv) return path.resolve(harnessEnv)
    return finnyArtifactPath("pythonEnv")
  }

  export function managedPythonBin(): string {
    return pythonBinForEnvDir(managedEnvDir())
  }

  export function managedPipBin(): string {
    return pipBinForEnvDir(managedEnvDir())
  }

  async function exists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath)
      return true
    } catch {
      return false
    }
  }

  function uvCacheDir(): string {
    return path.join(Global.Path.cache, "uv")
  }

  function uvEnv(): NodeJS.ProcessEnv {
    return { ...process.env, UV_CACHE_DIR: uvCacheDir() }
  }

  async function detectUv(): Promise<string | undefined> {
    const configured = process.env.FINNY_UV_BIN?.trim()
    if (configured) {
      try {
        const result = await Process.run([configured, "--version"], { nothrow: true, env: uvEnv() })
        if (result.code === 0) return configured
      } catch {}
      return undefined
    }
    try {
      const result = await Process.run(["uv", "--version"], { nothrow: true, env: uvEnv() })
      if (result.code === 0) return "uv"
    } catch {}
    return undefined
  }

  export function envMarkerPath(envDir: string): string {
    return path.join(envDir, ENV_MARKER)
  }

  export async function readEnvMarker(envDir: string): Promise<EnvMarker | undefined> {
    try {
      const raw = await fs.readFile(envMarkerPath(envDir), "utf8")
      const parsed = JSON.parse(raw) as EnvMarker
      if (!parsed?.python || !Array.isArray(parsed.packages)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  function packageKey(pkg: PackageRequirement): string {
    return `${pkg.spec}::${pkg.importCheck}`
  }

  function packageSpecsMatch(
    markerPackages: PackageRequirement[],
    requestedPackages: PackageRequirement[],
    allowMarkerSuperset: boolean,
  ): boolean {
    const markerKeys = markerPackages.map(packageKey).sort()
    const requestedKeys = requestedPackages.map(packageKey).sort()
    if (allowMarkerSuperset) {
      const marker = new Set(markerKeys)
      return requestedKeys.every((key) => marker.has(key))
    }
    return markerKeys.length === requestedKeys.length && markerKeys.every((key, index) => key === requestedKeys[index])
  }

  function isLockedHarnessEnv(envDir: string): boolean {
    const configured = process.env.FINNY_HARNESS_PYTHON_ENV?.trim()
    if (process.env.FINNY_HARNESS_MODE !== "1" || !configured) return false
    return path.resolve(configured) === path.resolve(envDir)
  }

  export async function envMarkerValid(envDir: string, packages: PackageRequirement[]): Promise<boolean> {
    const pyBin = pythonBinForEnvDir(envDir)
    if (!(await exists(pyBin))) return false
    const marker = await readEnvMarker(envDir)
    if (!marker) return false
    if (marker.python !== pyBin) return false
    if (!packageSpecsMatch(marker.packages, packages, isLockedHarnessEnv(envDir))) return false
    for (const pkg of packages) {
      if (!(await checkPackage(pyBin, pkg.importCheck))) return false
    }
    return true
  }

  async function writeEnvMarker(
    envDir: string,
    installer: EnvMarker["installer"],
    packages: PackageRequirement[],
  ): Promise<void> {
    const marker: EnvMarker = {
      installer,
      python: pythonBinForEnvDir(envDir),
      packages,
      verifiedAt: new Date().toISOString(),
    }
    await fs.writeFile(envMarkerPath(envDir), JSON.stringify(marker, null, 2) + "\n", "utf8")
  }

  async function systemPython(): Promise<string> {
    for (const candidate of [
      "/opt/homebrew/opt/python@3.13/bin/python3",
      "/opt/homebrew/opt/python@3.12/bin/python3",
      "/opt/homebrew/opt/python@3.11/bin/python3",
    ]) {
      try {
        const result = await Process.run([candidate, "-c", "from xml.parsers import expat"], { nothrow: true })
        if (result.code === 0) return candidate
      } catch {}
    }
    try {
      await Process.run(["python3", "--version"])
      return "python3"
    } catch {}
    try {
      await Process.run(["python", "--version"])
      return "python"
    } catch {}
    throw new Error("Python 3 not found. Install Python 3 (e.g. brew install python3) and try again.")
  }

  async function createVenv(envDir: string, onProgress: ProgressCallback): Promise<"uv" | "pip"> {
    onProgress("Creating Python environment…")
    const sysPy = await systemPython()
    await fs.mkdir(path.dirname(envDir), { recursive: true })
    await fs.mkdir(uvCacheDir(), { recursive: true }).catch(() => undefined)

    const uv = await detectUv()
    if (uv) {
      const result = await Process.run(uvVenvCommand(uv, envDir, sysPy), {
        nothrow: true,
        timeout: 120_000,
        env: uvEnv(),
      })
      if (result.code === 0) {
        log.info("venv created with uv", { envDir })
        return "uv"
      }
      const stderr = result.stderr.toString().trim()
      log.warn("uv venv failed; falling back to python -m venv", { envDir, stderr })
    }

    const result = await Process.run([sysPy, "-m", "venv", envDir], {
      nothrow: true,
      timeout: 120_000,
    })
    if (result.code !== 0) {
      const stderr = result.stderr.toString().trim()
      throw new Error(
        `venv creation failed: ${stderr || "unknown error"}\n\n` +
          `You may need the venv module. On Debian/Ubuntu: apt install python3-venv.`,
      )
    }
    log.info("venv created", { envDir })
    return "pip"
  }

  export function uvVenvCommand(uv: string, envDir: string, sysPy: string): string[] {
    return [uv, "venv", envDir, "--python", sysPy, "--seed"]
  }

  async function checkPackage(pyBin: string, importCheck: string): Promise<boolean> {
    if (!(await exists(pyBin))) return false
    const result = await Process.run([pyBin, "-c", `import ${importCheck}`], {
      nothrow: true,
      timeout: 10_000,
    })
    return result.code === 0
  }

  async function pipInstall(
    pyBin: string,
    specs: string[],
    onProgress: ProgressCallback,
    installer: "uv" | "pip" = "pip",
  ): Promise<void> {
    if (specs.length === 0) return
    onProgress(`Installing finance libraries (${specs.join(", ")}) — one-time, may take 30-60s…`)

    if (installer === "uv") {
      const uv = await detectUv()
      if (uv) {
        const result = await Process.run([uv, "pip", "install", "--python", pyBin, ...specs], {
          nothrow: true,
          timeout: 240_000,
          env: uvEnv(),
        })
        if (result.code === 0) {
          log.info("packages installed with uv", { packages: specs, envDir: path.dirname(pyBin) })
          return
        }
        const stderr = result.stderr.toString().trim()
        log.warn("uv pip install failed; falling back to pip", { stderr })
      }
    }

    // Upgrade pip quietly first so older pips don't choke on modern wheels.
    await Process.run([pyBin, "-m", "pip", "install", "--quiet", "--upgrade", "pip"], {
      nothrow: true,
      timeout: 120_000,
    }).catch(() => undefined)

    const result = await Process.run(
      [pyBin, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", ...specs],
      { nothrow: true, timeout: 240_000 },
    )
    if (result.code !== 0) {
      const stderr = result.stderr.toString().trim()
      throw new Error(
        `pip install failed: ${stderr || "unknown error"}\n\n` +
          `Try running manually: ${pyBin} -m pip install ${specs.join(" ")}`,
      )
    }
    log.info("packages installed", { packages: specs, envDir: path.dirname(pyBin) })
  }

  /**
   * Ensure the managed venv exists and every package in {@link packages} is
   * importable. Fast path (already installed) returns in < 100ms; cold path
   * pays a 30-60s venv-create + pip-install once.
   *
   * Concurrent calls in the same process (e.g. quote / history / backtest
   * tools firing in parallel during a single agent turn) are serialized per
   * env directory. Without this, two cold callers could race through
   * `createVenv` and `pipInstall` against the same directory, occasionally
   * corrupting the env or producing flaky "module not found" errors.
   * Cross-process locking (e.g. when multiple finny instances run
   * concurrently) is intentionally not handled here — callers in that
   * scenario should retry or run `Python.reset()`.
   */
  const queues = new Map<string, Promise<void>>()

  function withEnvQueue<T>(envDir: string, run: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    const wait = queues.get(envDir) ?? Promise.resolve()
    queues.set(
      envDir,
      wait.then(() => next),
    )
    return wait.then(run).finally(() => release?.())
  }

  export async function ensurePythonEnvAt(
    envDir: string,
    packages: PackageRequirement[],
    onProgress: ProgressCallback = () => {},
  ): Promise<Environment> {
    const pyBin = pythonBinForEnvDir(envDir)
    const pipBin = pipBinForEnvDir(envDir)

    return withEnvQueue(envDir, async () => {
      let installer: "uv" | "pip" = "pip"
      if (await envMarkerValid(envDir, packages)) {
        onProgress("Using existing Python environment…")
        return { python: pyBin, pip: pipBin, envDir }
      }
      if (isLockedHarnessEnv(envDir)) {
        throw new Error(
          "Locked harness Python runtime is missing an exact requested package spec/import or its environment marker; dynamic installation is disabled.",
        )
      }

      if (!(await exists(pyBin))) {
        installer = await createVenv(envDir, onProgress)
      } else {
        onProgress("Using existing Python environment…")
        const marker = await readEnvMarker(envDir)
        if (marker?.installer === "uv" || marker?.installer === "pip") installer = marker.installer
      }
      const missing: string[] = []
      for (const pkg of packages) {
        if (!(await checkPackage(pyBin, pkg.importCheck))) missing.push(pkg.spec)
      }
      if (missing.length > 0) {
        await pipInstall(pyBin, missing, onProgress, installer)
      } else {
        const names = packages.map((pkg) => pkg.importCheck).join(", ")
        onProgress(`Finance libraries verified (${names})`)
      }
      await writeEnvMarker(envDir, installer, packages)
      return { python: pyBin, pip: pipBin, envDir }
    })
  }

  export async function ensurePythonEnv(
    packages: PackageRequirement[],
    onProgress: ProgressCallback = () => {},
  ): Promise<Environment> {
    return ensurePythonEnvAt(managedEnvDir(), packages, onProgress)
  }

  export async function reset(envDir: string = managedEnvDir()): Promise<void> {
    await fs.rm(envDir, { recursive: true, force: true })
    queues.delete(envDir)
  }

  export const PATHS = {
    get ENV_DIR() {
      return managedEnvDir()
    },
    get PY_BIN() {
      return managedPythonBin()
    },
    get PIP_BIN() {
      return managedPipBin()
    },
  }
}

export const ensurePythonEnv = Python.ensurePythonEnv
export const ensurePythonEnvAt = Python.ensurePythonEnvAt
