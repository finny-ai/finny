// @codescene(disable-all) Managed Python env path/installer surface is intentionally string-heavy.
import fs from "fs/promises"
import fsSync from "node:fs"
import path from "path"
import { createHash, randomUUID } from "node:crypto"
import { Process } from "@/util/process"
import { Log } from "@/util/log"
import { Global } from "@/global"
import { finnyArtifactPath } from "@finny-ai/core/prefs"

const log = Log.create({ service: "python.env" })
const IS_WIN = process.platform === "win32"
export const ENV_MARKER = ".finny-env-ready.json"

/**
 * Managed Python venvs shared across the live runner and backtest runner.
 * Package sets are content-addressed under `$FINNY_HOME/python-envs`.
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

  export function sharedEnvsRoot(): string {
    return finnyArtifactPath("pythonEnvs")
  }

  function canonicalPackages(packages: PackageRequirement[]): PackageRequirement[] {
    const unique = new Map<string, PackageRequirement>()
    for (const pkg of packages) {
      const normalized = { spec: pkg.spec.trim(), importCheck: pkg.importCheck.trim() }
      unique.set(packageKey(normalized), normalized)
    }
    return Array.from(unique.values()).sort((a, b) => packageKey(a).localeCompare(packageKey(b)))
  }

  export function packageSetHash(packages: PackageRequirement[]): string {
    return createHash("sha256")
      .update(JSON.stringify(canonicalPackages(packages)))
      .digest("hex")
  }

  export function sharedEnvDir(packages: PackageRequirement[]): string {
    return path.join(sharedEnvsRoot(), packageSetHash(packages))
  }

  export function sharedEnvBuildMarkerPath(envDir: string): string {
    return `${envDir}.building.json`
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

  const LOCK_RETRY_MS = 100
  const LOCK_TIMEOUT_MS = 300_000
  const LOCK_STALE_MS = 10 * 60_000

  function processAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error: any) {
      return error?.code === "EPERM"
    }
  }

  async function removeStaleLock(lockDir: string): Promise<boolean> {
    try {
      const [ownerRaw, stat] = await Promise.all([
        fs.readFile(path.join(lockDir, "owner.json"), "utf8").catch(() => ""),
        fs.stat(lockDir),
      ])
      let owner: { pid: number; createdAt: string } | undefined
      try {
        const parsed: unknown = JSON.parse(ownerRaw || "{}")
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "pid" in parsed &&
          typeof parsed.pid === "number" &&
          "createdAt" in parsed &&
          typeof parsed.createdAt === "string"
        ) {
          owner = { pid: parsed.pid, createdAt: parsed.createdAt }
        }
      } catch {}
      if (!owner || Date.now() - stat.mtimeMs < LOCK_STALE_MS || processAlive(owner.pid)) return false
      await fs.rm(lockDir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  export async function withFilesystemEnvLock<T>(envDir: string, run: () => Promise<T>): Promise<T> {
    const lockDir = `${envDir}.lock`
    await fs.mkdir(path.dirname(envDir), { recursive: true })
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    while (true) {
      try {
        await fs.mkdir(lockDir)
        try {
          await fs.writeFile(
            path.join(lockDir, "owner.json"),
            JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
            "utf8",
          )
        } catch (error) {
          await fs.rm(lockDir, { recursive: true, force: true })
          throw error
        }
        break
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error
        if (await removeStaleLock(lockDir)) continue
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for Python environment lock: ${lockDir}`, { cause: error })
        }
        await Bun.sleep(LOCK_RETRY_MS)
      }
    }
    try {
      return await run()
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true })
    }
  }

  const leasedEnvs = new Map<string, string>()
  let leaseCleanupRegistered = false

  function cleanupLeasesSync(): void {
    for (const lease of leasedEnvs.values()) {
      try {
        fsSync.unlinkSync(lease)
      } catch {}
    }
  }

  async function acquireEnvLease(envDir: string): Promise<void> {
    if (leasedEnvs.has(envDir)) return
    const leasesDir = path.join(envDir, ".finny-env-leases")
    await fs.mkdir(leasesDir, { recursive: true })
    const lease = path.join(leasesDir, String(process.pid))
    await fs
      .writeFile(lease, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n", {
        flag: "wx",
      })
      .catch(async (error: any) => {
        if (error?.code !== "EEXIST") throw error
        await fs.utimes(lease, new Date(), new Date())
      })
    leasedEnvs.set(envDir, lease)
    if (!leaseCleanupRegistered) {
      process.once("exit", cleanupLeasesSync)
      leaseCleanupRegistered = true
    }
  }

  export async function hasLiveEnvLease(envDir: string): Promise<boolean> {
    const leasesDir = path.join(envDir, ".finny-env-leases")
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(leasesDir, { withFileTypes: true })
    } catch (error: any) {
      if (error?.code === "ENOENT") return false
      throw error
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d+$/.test(entry.name)) continue
      const pid = Number(entry.name)
      const recognized = await fs
        .readFile(path.join(leasesDir, entry.name), "utf8")
        .then((raw) => {
          const parsed: unknown = JSON.parse(raw)
          return (
            typeof parsed === "object" &&
            parsed !== null &&
            "pid" in parsed &&
            parsed.pid === pid &&
            "createdAt" in parsed &&
            typeof parsed.createdAt === "string"
          )
        })
        .catch(() => false)
      if (!recognized || processAlive(pid)) return true
      await fs.unlink(path.join(leasesDir, entry.name)).catch(() => undefined)
    }
    return false
  }

  async function readSharedBuildMarker(
    envDir: string,
  ): Promise<{ envDir: string; packageSetHash: string } | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(sharedEnvBuildMarkerPath(envDir), "utf8"))
      if (typeof parsed !== "object" || parsed === null) return undefined
      if (!("envDir" in parsed) || parsed.envDir !== envDir) return undefined
      if (!("packageSetHash" in parsed) || typeof parsed.packageSetHash !== "string") return undefined
      return { envDir: parsed.envDir, packageSetHash: parsed.packageSetHash }
    } catch {
      return undefined
    }
  }

  async function prepareSharedEnvDir(envDir: string, packages: PackageRequirement[]): Promise<void> {
    const expectedHash = packageSetHash(packages)
    const buildMarker = sharedEnvBuildMarkerPath(envDir)
    let stat: import("node:fs").Stats | undefined
    try {
      stat = await fs.lstat(envDir)
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
    }
    if (!stat) {
      const interrupted = await readSharedBuildMarker(envDir)
      if (interrupted?.packageSetHash === expectedHash) return
      if (await exists(buildMarker)) {
        throw new Error(`Refusing to overwrite an unrecognized Python environment build marker: ${buildMarker}`)
      }
      await fs.writeFile(
        buildMarker,
        JSON.stringify({
          envDir,
          packageSetHash: expectedHash,
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }) + "\n",
        { encoding: "utf8", flag: "wx" },
      )
      return
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to use non-directory or symlinked shared Python environment path: ${envDir}`)
    }
    const marker = await readEnvMarker(envDir)
    if (marker) {
      if (packageSetHash(marker.packages) !== expectedHash || marker.python !== pythonBinForEnvDir(envDir)) {
        throw new Error(`Refusing to modify shared Python environment with a mismatched Finny marker: ${envDir}`)
      }
      await fs.unlink(buildMarker).catch(() => undefined)
      return
    }
    const interrupted = await readSharedBuildMarker(envDir)
    if (!interrupted || interrupted.packageSetHash !== expectedHash) {
      throw new Error(
        `Refusing to modify unrecognized data at shared Python environment path: ${envDir}. ` +
          "Move it aside or inspect it before retrying.",
      )
    }
    const quarantine = `${envDir}.incomplete-${Date.now()}-${randomUUID().slice(0, 8)}`
    await fs.rename(envDir, quarantine)
    await fs.unlink(buildMarker)
    await fs.writeFile(
      buildMarker,
      JSON.stringify({ envDir, packageSetHash: expectedHash, pid: process.pid, createdAt: new Date().toISOString() }) +
        "\n",
      { encoding: "utf8", flag: "wx" },
    )
    log.warn("preserved interrupted Python environment build", { envDir, quarantine })
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
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null) return undefined
      if (!("installer" in parsed) || (parsed.installer !== "uv" && parsed.installer !== "pip")) return undefined
      if (!("python" in parsed) || typeof parsed.python !== "string" || !parsed.python) return undefined
      if (!("verifiedAt" in parsed) || typeof parsed.verifiedAt !== "string") return undefined
      if (
        !("packages" in parsed) ||
        !Array.isArray(parsed.packages) ||
        !parsed.packages.every(
          (pkg) =>
            typeof pkg === "object" &&
            pkg !== null &&
            "spec" in pkg &&
            typeof pkg.spec === "string" &&
            "importCheck" in pkg &&
            typeof pkg.importCheck === "string",
        )
      )
        return undefined
      return {
        installer: parsed.installer,
        python: parsed.python,
        packages: parsed.packages,
        verifiedAt: parsed.verifiedAt,
      }
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
        const envDir = path.dirname(path.dirname(pyBin))
        const hardlink =
          (await Promise.all([fs.stat(envDir), fs.stat(uvCacheDir())]).then(
            ([envStat, cacheStat]) => envStat.dev === cacheStat.dev,
            () => false,
          )) && !IS_WIN
        const result = await Process.run(
          [uv, "pip", "install", "--python", pyBin, ...(hardlink ? ["--link-mode", "hardlink"] : []), ...specs],
          {
            nothrow: true,
            timeout: 240_000,
            env: uvEnv(),
          },
        )
        if (result.code === 0) {
          log.info("packages installed with uv", {
            packages: specs,
            envDir,
            linkMode: hardlink ? "hardlink" : "default",
          })
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
   * This low-level helper serializes within one process. Shared managed
   * callers enter through {@link ensurePythonEnv}, which adds a cross-process
   * filesystem lock and an active-use lease.
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
        const now = new Date()
        await fs.utimes(envMarkerPath(envDir), now, now)
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
    if (isLockedHarnessEnv(managedEnvDir())) {
      return ensurePythonEnvAt(managedEnvDir(), packages, onProgress)
    }
    const canonical = canonicalPackages(packages)
    const envDir = sharedEnvDir(canonical)
    return withFilesystemEnvLock(envDir, async () => {
      await prepareSharedEnvDir(envDir, canonical)
      const env = await ensurePythonEnvAt(envDir, canonical, onProgress)
      await acquireEnvLease(envDir)
      await fs.unlink(sharedEnvBuildMarkerPath(envDir)).catch(() => undefined)
      return env
    })
  }

  export async function resetSharedPythonEnv(packages: PackageRequirement[]): Promise<void> {
    const canonical = canonicalPackages(packages)
    const envDir = sharedEnvDir(canonical)
    await withFilesystemEnvLock(envDir, async () => {
      const ownLease = leasedEnvs.get(envDir)
      if (ownLease) {
        await fs.unlink(ownLease).catch(() => undefined)
        leasedEnvs.delete(envDir)
      }
      if (await hasLiveEnvLease(envDir)) {
        throw new Error(
          `Refusing to reset a shared Python environment that is active in another Finny process: ${envDir}`,
        )
      }
      const marker = await readEnvMarker(envDir)
      if (!marker) return
      if (
        packageSetHash(marker.packages) !== packageSetHash(canonical) ||
        marker.python !== pythonBinForEnvDir(envDir)
      ) {
        throw new Error(`Refusing to reset a shared Python environment with a mismatched Finny marker: ${envDir}`)
      }
      await fs.rm(envDir, { recursive: true })
      queues.delete(envDir)
    })
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
