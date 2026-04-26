import fs from "fs/promises"
import path from "path"
import { Process } from "@/util/process"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { BrokerRegistry } from "./brokers"

const log = Log.create({ service: "live.python-env" })

export namespace PythonEnv {
  const ENV_DIR = path.join(Global.Path.data, "python-env")
  const IS_WIN = process.platform === "win32"
  const PY_BIN = IS_WIN ? path.join(ENV_DIR, "Scripts", "python.exe") : path.join(ENV_DIR, "bin", "python")
  const PIP_BIN = IS_WIN ? path.join(ENV_DIR, "Scripts", "pip.exe") : path.join(ENV_DIR, "bin", "pip")

  // Always-required packages (independent of any broker).
  const BASE_PACKAGES = [{ spec: "pytz", importCheck: "pytz" }]

  function requiredPackages(): { spec: string; importCheck: string }[] {
    return [...BASE_PACKAGES, ...BrokerRegistry.unionPythonDeps()]
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
    // Try python3 first, fall back to python
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

  async function installPackages(onProgress: ProgressCallback): Promise<void> {
    const specs = requiredPackages()
      .map((p) => p.spec)
      .filter((s) => s.length > 0)
    onProgress(`Installing ${specs.join(", ")} (this takes 30-60s, one-time)…`)

    // Upgrade pip quietly first so older pips don't choke on modern wheels.
    await Process.run([PY_BIN, "-m", "pip", "install", "--quiet", "--upgrade", "pip"], {
      nothrow: true,
      timeout: 120_000,
    }).catch(() => undefined)

    const result = await Process.run(
      [PY_BIN, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", ...specs],
      {
        nothrow: true,
        timeout: 240_000,
      },
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
   * Ensure a managed Python env exists at ~/.local/share/finny/python-env with
   * alpaca-py installed. Returns the python binary path.
   *
   * Fast path (already set up): returns in <100ms.
   * Cold path (first call ever): creates venv + installs alpaca-py. Takes 30-60s.
   *
   * Progress messages are streamed via `onProgress` so callers can surface them
   * in the UI (e.g. into a live run's log panel).
   */
  export async function ensure(onProgress: ProgressCallback = () => {}): Promise<Environment> {
    // Fast path: venv exists and every required package is importable.
    if (await exists(PY_BIN)) {
      let allOk = true
      for (const pkg of requiredPackages()) {
        if (!(await checkPackage(pkg.importCheck))) {
          allOk = false
          break
        }
      }
      if (allOk) {
        return { python: PY_BIN, pip: PIP_BIN, envDir: ENV_DIR }
      }
      // Venv exists but packages missing — re-install.
      await installPackages(onProgress)
      return { python: PY_BIN, pip: PIP_BIN, envDir: ENV_DIR }
    }

    // Cold path: full setup.
    await createVenv(onProgress)
    await installPackages(onProgress)
    return { python: PY_BIN, pip: PIP_BIN, envDir: ENV_DIR }
  }

  /**
   * Nuke the managed env. Useful for recovery if install state gets corrupted.
   */
  export async function reset(): Promise<void> {
    await fs.rm(ENV_DIR, { recursive: true, force: true })
  }
}
