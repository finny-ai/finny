// @codescene(disable-all) Locked Python runtime sync is a harness integrity boundary.
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { sha256File } from "./artifacts"
import { runCommand } from "./process"

const RuntimeManifest = z.object({
  schemaVersion: z.literal(1),
  bun: z.string().min(1),
  uv: z.string().min(1),
  python: z.array(z.string().regex(/^3\.(?:12|13)$/)).min(1),
  lockfile: z.string().min(1),
  project: z.string().min(1),
})

type RuntimeManifestV1 = z.infer<typeof RuntimeManifest>

type RuntimeLayout = {
  runtimeDir: string
  manifestPath: string
  lockPath: string
  manifest: RuntimeManifestV1
}

export type LockedPythonRuntime = {
  python: string
  pythonVersion: string
  uvVersion: string
  packagesSha256: string
  lockSha256: string
  manifestSha256: string
}

const harnessPackages = [
  { spec: "numpy", importCheck: "numpy" },
  { spec: "pandas", importCheck: "pandas" },
  { spec: "yfinance", importCheck: "yfinance" },
  { spec: "requests", importCheck: "requests" },
  { spec: "scipy", importCheck: "scipy" },
  { spec: "pyarrow", importCheck: "pyarrow" },
  { spec: "pytz", importCheck: "pytz" },
] as const

function versionNumber(value: string): string {
  return value.trim().split(/\s+/).at(1) ?? ""
}

async function loadRuntimeLayout(source: string): Promise<RuntimeLayout> {
  const runtimeDir = path.join(source, "packages", "opencode", "python")
  const manifestPath = path.join(runtimeDir, "runtime-manifest.json")
  const manifest = RuntimeManifest.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")))
  return {
    runtimeDir,
    manifestPath,
    lockPath: path.join(runtimeDir, manifest.lockfile),
    manifest,
  }
}

function assertBunVersion(manifest: RuntimeManifestV1): void {
  if (Bun.version !== manifest.bun) {
    throw new Error(`Bun runtime mismatch: expected ${manifest.bun}, received ${Bun.version}`)
  }
}

async function inspectUvVersion(input: {
  source: string
  env: Record<string, string>
  expectedVersion: string
}): Promise<string> {
  const result = await runCommand({
    command: "uv",
    args: ["--version"],
    cwd: input.source,
    env: input.env,
    inheritEnv: false,
    timeoutMs: 10_000,
  })
  const actualVersion = versionNumber(result.stdout || result.stderr)
  if (result.exitCode !== 0 || actualVersion !== input.expectedVersion) {
    throw new Error(`uv runtime mismatch: expected ${input.expectedVersion}, received ${actualVersion || "unavailable"}`)
  }
  return actualVersion
}

function pythonEnvironment(input: { env: Record<string, string>; envDir: string }): Record<string, string> {
  return {
    ...input.env,
    UV_PROJECT_ENVIRONMENT: input.envDir,
    VIRTUAL_ENV: input.envDir,
  }
}

async function syncLockedEnvironment(input: {
  source: string
  runtimeDir: string
  env: Record<string, string>
  pythonMinor: string
  timeoutMs: number
}): Promise<void> {
  const result = await runCommand({
    command: "uv",
    args: ["sync", "--frozen", "--no-dev", "--project", input.runtimeDir, "--python", input.pythonMinor],
    cwd: input.source,
    env: input.env,
    inheritEnv: false,
    timeoutMs: input.timeoutMs,
  })
  if (result.exitCode !== 0) {
    throw new Error(`locked Python sync failed: ${(result.stderr || result.stdout).trim() || "unknown uv error"}`)
  }
}

function pythonExecutable(envDir: string): string {
  return process.platform === "win32" ? path.join(envDir, "Scripts", "python.exe") : path.join(envDir, "bin", "python")
}

function assertPythonVersion(input: { actualVersion: string; supportedMinors: string[] }): void {
  if (!input.supportedMinors.some((minor) => input.actualVersion.startsWith(`${minor}.`))) {
    throw new Error(
      `Python runtime mismatch: expected ${input.supportedMinors.join(" or ")}, received ${input.actualVersion}`,
    )
  }
}

async function writeReadyMarker(input: { envDir: string; python: string }): Promise<void> {
  const marker = {
    installer: "uv",
    python: input.python,
    packages: harnessPackages,
    verifiedAt: new Date().toISOString(),
  }
  await fs.writeFile(path.join(input.envDir, ".finny-env-ready.json"), `${JSON.stringify(marker, null, 2)}\n`)
}

function exposePythonRuntime(input: { env: Record<string, string>; envDir: string }): void {
  input.env.FINNY_HARNESS_PYTHON_ENV = input.envDir
  input.env.FINNY_UV_BIN = "uv"
  input.env.VIRTUAL_ENV = input.envDir
}

export async function inspectLockedPythonRuntime(input: {
  python: string
  cwd: string
  env: Record<string, string>
}): Promise<{ pythonVersion: string; packagesSha256: string }> {
  const fingerprint = await runCommand({
    command: input.python,
    args: [
      "-c",
      [
        "import hashlib, importlib.metadata as m, json, platform",
        `import ${harnessPackages.map((item) => item.importCheck).join(", ")}`,
        "p=sorted(f\"{d.metadata['Name']}=={d.version}\" for d in m.distributions())",
        "raw=('\\n'.join(p)+'\\n').encode()",
        "print(json.dumps({'python':platform.python_version(),'packages_sha256':hashlib.sha256(raw).hexdigest()}))",
      ].join(";"),
    ],
    cwd: input.cwd,
    env: {
      // Preserve PATH so the locked interpreter can resolve dyld/ssl helpers on macOS.
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin",
      ...input.env,
    },
    inheritEnv: false,
    // Cold imports of scipy/pyarrow can exceed 30s on first harness prep.
    timeoutMs: 120_000,
  })
  if (fingerprint.exitCode !== 0) {
    const detail =
      (fingerprint.stderr || fingerprint.stdout).trim() ||
      (fingerprint.timedOut ? `timed out after ${fingerprint.durationMs}ms` : `exit ${fingerprint.exitCode}`)
    throw new Error(`could not fingerprint locked Python runtime: ${detail}`)
  }
  const parsed = z
    .object({ python: z.string().min(1), packages_sha256: z.string().length(64) })
    .parse(JSON.parse(fingerprint.stdout.trim()))
  return { pythonVersion: parsed.python, packagesSha256: parsed.packages_sha256 }
}

export async function prepareLockedPythonRuntime(input: {
  source: string
  envDir: string
  env: Record<string, string>
  timeoutMs?: number
}): Promise<LockedPythonRuntime> {
  const layout = await loadRuntimeLayout(input.source)
  assertBunVersion(layout.manifest)
  const uvVersion = await inspectUvVersion({
    source: input.source,
    env: input.env,
    expectedVersion: layout.manifest.uv,
  })
  const syncEnv = pythonEnvironment(input)
  await syncLockedEnvironment({
    source: input.source,
    runtimeDir: layout.runtimeDir,
    env: syncEnv,
    pythonMinor: layout.manifest.python[0],
    timeoutMs: input.timeoutMs ?? 240_000,
  })
  const python = pythonExecutable(input.envDir)
  const inspected = await inspectLockedPythonRuntime({ python, cwd: layout.runtimeDir, env: syncEnv })
  assertPythonVersion({ actualVersion: inspected.pythonVersion, supportedMinors: layout.manifest.python })
  await writeReadyMarker({ envDir: input.envDir, python })
  exposePythonRuntime(input)
  return {
    python,
    pythonVersion: inspected.pythonVersion,
    uvVersion,
    packagesSha256: inspected.packagesSha256,
    lockSha256: await sha256File(layout.lockPath),
    manifestSha256: await sha256File(layout.manifestPath),
  }
}
