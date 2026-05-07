import fs from "fs/promises"
import path from "path"
import { Process } from "@/util/process"
import { Global } from "@/global"
import { Log } from "@/util/log"

const log = Log.create({ service: "python.env" })

/**
 * Managed Python venv shared across the live runner and the backtest runner.
 * One venv lives at `~/.local/share/finny/python-env`; callers declare the
 * packages they need and {@link ensurePythonEnv} installs anything missing.
 *
 * This intentionally bypasses PEP 668 / the system Python by creating a venv
 * up front — same binary, same import path on every machine, no
 * `--break-system-packages` games on Linux distros.
 */
export namespace Python {
  const ENV_DIR = path.join(Global.Path.data, "python-env")
  const IS_WIN = process.platform === "win32"
  const PY_BIN = IS_WIN ? path.join(ENV_DIR, "Scripts", "python.exe") : path.join(ENV_DIR, "bin", "python")
  const PIP_BIN = IS_WIN ? path.join(ENV_DIR, "Scripts", "pip.exe") : path.join(ENV_DIR, "bin", "pip")

  export interface PackageRequirement {
    /** pip spec, e.g. "yfinance" or "alpaca-py>=0.13". */
    spec: string
    /** Python module name to probe with `import <name>` after install. */
    importCheck: string
  }

  export type ProgressCallback = (message: string) => void

  export interface Environment {
    python: string
    pip: string
    envDir: string
  }

  async function exists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath)
      return true
    } catch {
      return false
    }
  }

  async function systemPython(): Promise<string> {
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

  async function createVenv(onProgress: ProgressCallback): Promise<void> {
    onProgress("Creating managed Python environment…")
    const sysPy = await systemPython()
    await fs.mkdir(Global.Path.data, { recursive: true })

    const result = await Process.run([sysPy, "-m", "venv", ENV_DIR], {
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
    log.info("venv created", { envDir: ENV_DIR })
  }

  async function checkPackage(importCheck: string): Promise<boolean> {
    if (!(await exists(PY_BIN))) return false
    const result = await Process.run([PY_BIN, "-c", `import ${importCheck}`], {
      nothrow: true,
      timeout: 10_000,
    })
    return result.code === 0
  }

  async function pipInstall(specs: string[], onProgress: ProgressCallback): Promise<void> {
    if (specs.length === 0) return
    onProgress(`Installing ${specs.join(", ")} (one-time, may take 30-60s)…`)

    // Upgrade pip quietly first so older pips don't choke on modern wheels.
    await Process.run([PY_BIN, "-m", "pip", "install", "--quiet", "--upgrade", "pip"], {
      nothrow: true,
      timeout: 120_000,
    }).catch(() => undefined)

    const result = await Process.run(
      [PY_BIN, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", ...specs],
      { nothrow: true, timeout: 240_000 },
    )
    if (result.code !== 0) {
      const stderr = result.stderr.toString().trim()
      throw new Error(
        `pip install failed: ${stderr || "unknown error"}\n\n` +
          `Try running manually: ${PY_BIN} -m pip install ${specs.join(" ")}`,
      )
    }
    onProgress("Python environment ready.")
    log.info("packages installed", { packages: specs })
  }

  /**
   * Ensure the managed venv exists and every package in {@link packages} is
   * importable. Fast path (already installed) returns in < 100ms; cold path
   * pays a 30-60s venv-create + pip-install once.
   *
   * Concurrent calls in the same process (e.g. quote / history / backtest
   * tools firing in parallel during a single agent turn) are serialized per
   * ENV_DIR. Without this, two cold callers could race through `createVenv`
   * and `pipInstall` against the same directory, occasionally corrupting the
   * env or producing flaky "module not found" errors. Cross-process locking
   * (e.g. when multiple finny instances run concurrently) is intentionally
   * not handled here — callers in that scenario should retry or run
   * `Python.reset()`.
   */
  const inflight = new Map<string, Promise<Environment>>()

  export async function ensurePythonEnv(
    packages: PackageRequirement[],
    onProgress: ProgressCallback = () => {},
  ): Promise<Environment> {
    // One lock per ENV_DIR so different package sets cannot race writes to
    // the same virtualenv.
    const key = ENV_DIR
    while (true) {
      const existing = inflight.get(key)
      if (!existing) break
      await existing
    }

    const promise = (async () => {
      if (!(await exists(PY_BIN))) {
        await createVenv(onProgress)
      }
      const missing: string[] = []
      for (const pkg of packages) {
        if (!(await checkPackage(pkg.importCheck))) missing.push(pkg.spec)
      }
      if (missing.length > 0) {
        await pipInstall(missing, onProgress)
      }
      return { python: PY_BIN, pip: PIP_BIN, envDir: ENV_DIR }
    })().finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key)
    })

    inflight.set(key, promise)
    return promise
  }

  /** Nuke the managed env. Useful for recovery if install state corrupts. */
  export async function reset(): Promise<void> {
    await fs.rm(ENV_DIR, { recursive: true, force: true })
  }

  export const PATHS = { ENV_DIR, PY_BIN, PIP_BIN }
}

export const ensurePythonEnv = Python.ensurePythonEnv
