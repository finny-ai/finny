import { Flag } from "../../flag/flag"
import { Process } from "../../util/process"
import {
  LEAN_IMAGE_REF,
  LEAN_PINNED_COMMIT,
  LEAN_PINNED_IMAGE_DIGEST,
  verifyExecutionProfile,
} from "./contracts"
import type { LeanAdapterContextV1, LeanAdapterResultV1, LeanAdapterV1 } from "./runner"
import type { LeanAdapterFailureV1 } from "./types"
import { buildLeanLauncherConfig } from "./engine-config"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const ADAPTER_CERT_ENV = "FINNY_LEAN_ADAPTER_CERT"
const ADAPTER_CERT_VALUE = "finny-lean-adapter-cert-v1"
const DOCKER_BASE_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  HOME: process.env.HOME ?? "/tmp",
}

let dockerHostPromise: Promise<string | undefined> | undefined
async function resolveDockerHost(): Promise<string | undefined> {
  const inherited = process.env.DOCKER_HOST
  if (inherited) return inherited
  dockerHostPromise ??= (async () => {
    const probe = await Process.run(
      ["docker", "context", "ls", "--format", "{{.Name}}|{{.Current}}|{{.DockerEndpoint}}"],
      { nothrow: true, timeout: 15_000, env: DOCKER_BASE_ENV, inheritEnv: false },
    )
    if (probe.code !== 0) return undefined
    const current = probe.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.split("|")[1] === "true")
    return current?.split("|")[2]
  })()
  return dockerHostPromise
}

/**
 * The overlay dev image publishes the launcher under bin/Debug while the
 * production image publishes Release directly under /Lean/Launcher. The path
 * is resolved from the pinned image once per process so both layouts work and
 * an unrecognized image fails closed.
 */
let launcherPathPromise: Promise<string | undefined> | undefined
async function resolveLauncherPath(env: Record<string, string>): Promise<string | undefined> {
  launcherPathPromise ??= (async () => {
    const probe = await Process.run(
      [
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        LEAN_PINNED_IMAGE_DIGEST,
        "-c",
        'for p in /Lean/Launcher/bin/Debug/QuantConnect.Lean.Launcher.dll /Lean/Launcher/QuantConnect.Lean.Launcher.dll; do [ -f "$p" ] && echo "$p" && exit 0; done; exit 1',
      ],
      { nothrow: true, timeout: 30_000, env, inheritEnv: false },
    )
    if (probe.code !== 0) return undefined
    const first = probe.stdout.toString().trim().split("\n")[0]
    return first || undefined
  })()
  return launcherPathPromise
}

async function dockerEnv(): Promise<Record<string, string>> {
  const host = await resolveDockerHost()
  return host ? { ...DOCKER_BASE_ENV, DOCKER_HOST: host } : DOCKER_BASE_ENV
}

/**
 * Colima/Docker Desktop cannot bind-mount macOS temp paths (/var/folders),
 * so every run is relocated under the user home before mounting and the
 * results are copied back afterwards.
 */
interface LeanDockerRelocation {
  root: string
  resultsDir: string
}

async function relocateForDocker(input: {
  sourceDir: string
  scratchDir: string
  resultsDir: string
  runRoot?: string
}): Promise<LeanDockerRelocation> {
  // The harness isolates $HOME into a temp tree that colima cannot mount.
  // Bun's os.userInfo() mirrors $HOME, so derive the macOS account home from
  // USER; other platforms keep the regular home resolution.
  const realHome =
    process.platform === "darwin" && process.env.USER
      ? `/Users/${process.env.USER}`
      : os.userInfo().homedir || os.homedir()
  const base = input.runRoot ?? path.join(realHome, ".finny-lean-runs")
  const root = path.join(base, crypto.randomBytes(6).toString("hex"))
  try {
    await fs.mkdir(path.join(root, "scratch"), { recursive: true })
    await fs.mkdir(path.join(root, "source"), { recursive: true })
    await fs.mkdir(path.join(root, "results"), { recursive: true })
    await fs.cp(input.scratchDir, path.join(root, "scratch"), { recursive: true })
    await fs.cp(input.sourceDir, path.join(root, "source"), { recursive: true })
    await Promise.all([
      fs.chmod(path.join(root, "scratch"), 0o777).catch(() => undefined),
      fs.chmod(path.join(root, "results"), 0o777).catch(() => undefined),
    ])
    return { root, resultsDir: path.join(root, "results") }
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Relocate one run into a Docker-mountable directory and remove every copied
 * source/data/result byte after the callback settles, including typed failures
 * and thrown errors. `runRoot` exists for hermetic tests and hosted workers.
 */
export async function withLeanDockerRelocation<T>(
  input: { sourceDir: string; scratchDir: string; resultsDir: string; runRoot?: string },
  run: (relocated: LeanDockerRelocation) => Promise<T>,
): Promise<T> {
  const relocated = await relocateForDocker(input)
  try {
    return await run(relocated)
  } finally {
    await fs.rm(relocated.root, { recursive: true, force: true })
  }
}

function truthy(value: string | undefined): boolean {
  const normalized = value?.toLowerCase()
  return normalized === "true" || normalized === "1"
}

/**
 * Deterministic MSBuild project + build script for Finny C# LEAN algorithms.
 * The project references only assemblies baked into the pinned engine image
 * (no NuGet restore, no network) and targets the highest SDK major found in
 * the container, matching how LEAN itself resolves its runtime.
 */
export function csharpProjectScript(): string {
  return `set -e
LAUNCHER_DIR=/Lean/Launcher/bin/Debug
[ -d "\$LAUNCHER_DIR" ] || LAUNCHER_DIR=/Lean/Launcher
DLLS=\$(ls "\$LAUNCHER_DIR"/*.dll 2>/dev/null || true)
SDK_MAJOR=\$(dotnet --list-sdks | sed -n 's/^\\([0-9]*\\)\\..*/\\1/p' | sort -n | tail -1)
if [ -z "\$SDK_MAJOR" ]; then
  echo "finny: no dotnet SDK in the pinned engine image" >&2
  exit 2
fi
TFM="net\${SDK_MAJOR}.0"
{
  echo '<Project Sdk="Microsoft.NET.Sdk">'
  echo '  <PropertyGroup>'
  echo "    <TargetFramework>\$TFM</TargetFramework>"
  echo '    <OutputType>Library</OutputType>'
  echo '    <AssemblyName>Algorithm</AssemblyName>'
  echo '    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>'
  echo '    <GenerateAssemblyInfo>false</GenerateAssemblyInfo>'
  echo '    <Deterministic>true</Deterministic>'
  echo '    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>'
  echo '    <RestoreSources></RestoreSources>'
  echo '    <NuGetAudit>false</NuGetAudit>'
  echo '  </PropertyGroup>'
  echo '  <ItemGroup>'
  echo '    <Compile Include="/build/**/*.cs" />'
  for dll in \$DLLS; do
    name=\$(basename "\$dll")
    echo "    <Reference Include=\\"\$name\\"><HintPath>\$dll</HintPath><Private>false</Private></Reference>"
  done
  echo '  </ItemGroup>'
  echo '</Project>'
} > /build/FinnyAlgorithm.csproj
# dotnet may exit 1 on the workload-verification check when the SDK dir is
# read-only even after a successful build; the artifact is the gate.
dotnet build /build/FinnyAlgorithm.csproj -c Release --nologo -v minimal -o /build/out || true
test -f /build/out/Algorithm.dll
echo "finny: csharp build ok"
`
}

/**
 * Fail-closed LEAN execution adapter. No docker invocation happens unless the
 * feature flag, adapter certificate, pinned digest, and a supported platform
 * are all present. Any divergence surfaces as a typed failure; there is no
 * engine fallback.
 */
export class LeanAdapter implements LeanAdapterV1 {
  readonly profileId = "lean_python" as const

  probeReady(): { ready: boolean; reasons: string[] } {
    const reasons: string[] = []
    if (!Flag.FINNY_LEAN_ENABLED) reasons.push("FINNY_LEAN_ENABLED feature flag is disabled")
    if (process.env[ADAPTER_CERT_ENV] !== ADAPTER_CERT_VALUE) {
      reasons.push("LEAN adapter certificate is not set (FINNY_LEAN_ADAPTER_CERT)")
    }
    if (process.platform === "win32") reasons.push("LEAN execution is unsupported on win32 for v1")
    if (LEAN_PINNED_IMAGE_DIGEST.startsWith("sha256:000000000000")) {
      reasons.push("pinned LEAN engine image digest is a placeholder")
    }
    return { ready: reasons.length === 0, reasons }
  }

  async run(input: LeanAdapterContextV1): Promise<LeanAdapterResultV1> {
    const ready = this.probeReady()
    if (!ready.ready) {
      return failure("docker_unavailable", `LEAN adapter is not ready: ${ready.reasons.join("; ")}`)
    }

    const profileErrors = verifyExecutionProfile(input.bundle.executionProfile)
    if (profileErrors.length > 0) {
      return failure("model_policy_violation", `execution profile is invalid: ${profileErrors.join("; ")}`)
    }
    if (input.bundle.image.imageDigest !== LEAN_PINNED_IMAGE_DIGEST) {
      return failure(
        "image_digest_mismatch",
        `bundle image digest ${input.bundle.image.imageDigest} does not match the pinned digest`,
      )
    }
    if (input.bundle.image.leanCommit !== LEAN_PINNED_COMMIT) {
      return failure("image_digest_mismatch", `bundle LEAN commit does not match the pinned commit`)
    }

    const env = await dockerEnv()
    const launcherPath = await resolveLauncherPath(env)
    if (!launcherPath) {
      return failure(
        "image_unavailable",
        "pinned image exposes no QuantConnect.Lean.Launcher.dll under /Lean/Launcher",
      )
    }
    const docker = await Process.run(["docker", "version", "--format", "{{.Server.Version}}"], {
      nothrow: true,
      timeout: 15_000,
      env,
      inheritEnv: false,
    })
    if (docker.code !== 0) {
      return failure("docker_unavailable", `docker daemon is unavailable: ${docker.stderr.toString().trim()}`)
    }
    const inspect = await Process.run(
      ["docker", "image", "inspect", LEAN_PINNED_IMAGE_DIGEST, "--format", "{{json .RepoDigests}}"],
      { nothrow: true, timeout: 15_000, env, inheritEnv: false },
    )
    if (inspect.code !== 0) {
      return failure(
        "image_unavailable",
        `pinned image ${LEAN_PINNED_IMAGE_DIGEST} is not present; run the Finny lean-engine pull step first`,
      )
    }

    const launcherDir = launcherPath.slice(0, launcherPath.lastIndexOf("/"))
    // Offline, read-only, capability-dropped execution with controller-owned
    // limits. The pinned image runs the LEAN launcher directly; never the CLI.
    const launcher = buildLeanLauncherConfig({
      profile: input.bundle.executionProfile,
      assetFamily: input.dataBundle.assetFamily,
      startDate: input.window.start,
      endDate: input.window.end,
      cash: input.capital,
      algorithmTypeName: "Main",
      algorithmLanguage: input.bundle.profile.profileId === "lean_csharp" ? "CSharp" : "Python",
      algorithmLocation:
        input.bundle.profile.profileId === "lean_csharp" ? "/Lean/Algorithm/Algorithm.dll" : "/Lean/Algorithm/main.py",
      dataFolder: "/Lean/Data",
      resultsFolder: "/Results",
      seed: input.seed,
      dataFeedWorkers: input.bundle.executionProfile.dataFeedWorkers,
      launcherDir,
    })
    await fs.writeFile(`${input.scratchDir}/lean-config.json`, launcher.json, "utf8")
    const startedAt = new Date().toISOString()
    return await withLeanDockerRelocation({
      sourceDir: input.sourceDir,
      scratchDir: input.scratchDir,
      resultsDir: input.resultsDir,
    }, async (relocated) => {
      const mountScratch = path.join(relocated.root, "scratch")
      const mountSource = path.join(relocated.root, "source")
      const mountResults = relocated.resultsDir
      const mountStorage = path.join(relocated.root, "storage")
      await fs.mkdir(mountStorage, { recursive: true })
      const isCSharp = input.bundle.profile.profileId === "lean_csharp"
      let mountAlgorithm = mountSource
      if (isCSharp) {
        const compiled = await this.compileCSharp({
          env,
          relocatedRoot: relocated.root,
          mountScratch,
          sourceDir: input.sourceDir,
        })
        if (!compiled.ok) {
          return failure("compile_failed", `C# algorithm build failed: ${compiled.error}`)
        }
        mountAlgorithm = compiled.buildOutDir
      }
      // Container uid 10001 must be able to write results; host bind mounts on
      // macOS/CI do not map that uid, so widen dev scratch dirs. The production
      // posture uses uid-mapped volumes instead of 0777.
      await Promise.all([
        fs.chmod(mountScratch, 0o777).catch(() => undefined),
        fs.chmod(mountResults, 0o777).catch(() => undefined),
        fs.chmod(mountStorage, 0o777).catch(() => undefined),
      ])
      const cmd = [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "10001:10001",
        "--entrypoint",
        "dotnet",
        "--workdir",
        "/tmp",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--mount",
        `type=bind,source=${mountScratch},target=/Lean/Data,readonly`,
        "--mount",
        `type=bind,source=${mountAlgorithm},target=/Lean/Algorithm,readonly`,
        "--mount",
        `type=bind,source=${mountResults},target=/Results`,
        "--mount",
        `type=bind,source=${mountStorage},target=/Lean/Storage`,
        "--mount",
        "type=tmpfs,destination=/tmp",
        "--mount",
        `type=bind,source=${mountScratch}/lean-config.json,target=/Lean/Launcher/lean-config.json,readonly`,
        "--env",
        `FINNY_SEED=${input.seed}`,
        "--env",
        `FINNY_PHASE=${input.phase}`,
        "--env",
        "HOME=/tmp",
        LEAN_PINNED_IMAGE_DIGEST,
        launcherPath,
        "--config",
        "/Lean/Launcher/lean-config.json",
      ]

      const result = await Process.run(cmd, {
        nothrow: true,
        timeout: 20 * 60_000,
        env,
        inheritEnv: false,
      })
      if (result.code !== 0) {
        const stderr = result.stderr.toString().trim().slice(0, 4000)
        return failure("engine_crash", `LEAN engine exited ${result.code}: ${stderr}`)
      }
      try {
        await fs.cp(mountResults, input.resultsDir, { recursive: true })
      } catch (error) {
        return failure("results_unparseable", `LEAN results could not be collected: ${String(error)}`)
      }

      // Artifact parsing is performed by the canonical result mapper; the
      // adapter only asserts the expected files exist.
      try {
        const summaryCandidates = ["summary.json", "Main-summary.json"]
        let summaryPath = ""
        let summary = "{}"
        for (const candidate of summaryCandidates) {
          try {
            summary = await fs.readFile(`${input.resultsDir}/${candidate}`, "utf8")
            summaryPath = candidate
            break
          } catch {}
        }
        const resultCandidates = ["result.json", "Main.json"]
        let resultPath = ""
        for (const candidate of resultCandidates) {
          try {
            await fs.access(`${input.resultsDir}/${candidate}`)
            resultPath = candidate
            break
          } catch {}
        }
        if (!resultPath) {
          return failure("results_unparseable", `LEAN produced no result artifact in ${input.resultsDir}`)
        }
        return {
          ok: true,
          artifacts: {
            schema: "finny.lean_run_artifacts",
            version: 1,
            orders: [],
            fills: [],
            rejections: [],
            equityCurve: [],
            rawStatistics: JSON.parse(summary || "{}"),
            leanResultPath: resultPath ? `${input.resultsDir}/${resultPath}` : "",
            leanSummaryPath: summaryPath ? `${input.resultsDir}/${summaryPath}` : "",
          },
          container: {
            imageDigest: LEAN_PINNED_IMAGE_DIGEST,
            leanCommit: LEAN_PINNED_COMMIT,
            startedAt,
            completedAt: new Date().toISOString(),
            exitCode: result.code,
          },
        }
      } catch (error) {
        return failure("results_unparseable", `LEAN results could not be parsed: ${String(error)}`)
      }
    })
  }

  private async compileCSharp(input: {
    env: Record<string, string>
    relocatedRoot: string
    mountScratch: string
    sourceDir: string
  }): Promise<{ ok: true; buildOutDir: string } | { ok: false; error: string }> {
    const buildDir = path.join(input.relocatedRoot, "build")
    await fs.mkdir(buildDir, { recursive: true })
    const buildOutDir = path.join(buildDir, "out")
    await fs.mkdir(buildOutDir, { recursive: true })
    await fs.cp(input.sourceDir, buildDir, { recursive: true }).catch(() => undefined)
    await fs.chmod(buildDir, 0o777).catch(() => undefined)
    await fs.chmod(buildOutDir, 0o777).catch(() => undefined)
    const result = await Process.run(
      [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "10001:10001",
        "--entrypoint",
        "sh",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--mount",
        `type=bind,source=${buildDir},target=/build`,
        "--mount",
        "type=tmpfs,destination=/tmp",
        "--env",
        "HOME=/build",
        "--env",
        "DOTNET_CLI_TELEMETRY_OPTOUT=1",
        "--env",
        "DOTNET_NOLOGO=1",
        "--env",
        "DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1",
        "--env",
        "DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE=1",
        LEAN_PINNED_IMAGE_DIGEST,
        "-c",
        csharpProjectScript(),
      ],
      { nothrow: true, timeout: 10 * 60_000, env: input.env, inheritEnv: false },
    )
    if (result.code !== 0) {
      const stderr = result.stderr.toString().trim().slice(0, 2000)
      const stdout = result.stdout.toString().trim().slice(-2000)
      return {
        ok: false,
        error: `dotnet build exited ${result.code}: ${[stderr, stdout].filter(Boolean).join("\n").slice(0, 4000) || "no compiler output"}`,
      }
    }
    return { ok: true, buildOutDir }
  }
}

function failure(
  kind: LeanAdapterFailureV1["kind"],
  error: string,
  details?: Record<string, unknown>,
): LeanAdapterFailureV1 {
  return { ok: false, kind, error, details }
}

export function isLeanFeatureEnabled(): boolean {
  return Flag.FINNY_LEAN_ENABLED && truthy(process.env[ADAPTER_CERT_ENV] === ADAPTER_CERT_VALUE ? "1" : undefined)
}

export const LEAN_IMAGE_IDENTITY = {
  schema: "finny.lean_image_identity",
  version: 1,
  imageRef: LEAN_IMAGE_REF,
  imageDigest: LEAN_PINNED_IMAGE_DIGEST,
  leanCommit: LEAN_PINNED_COMMIT,
  architectures: ["linux/amd64", "linux/arm64"] as const,
  sbomSha256: "",
  provenanceSha256: "",
}
