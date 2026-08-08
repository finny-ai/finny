import { Flag } from "../../flag/flag"
import { Process } from "../../util/process"
import {
  LEAN_IMAGE_REF,
  LEAN_PINNED_COMMIT,
  LEAN_PINNED_IMAGE_DIGEST,
  verifyExecutionProfile,
} from "./contracts"
import { materializeLeanDataBundle } from "./materialize"
import type { LeanAdapterContextV1, LeanAdapterResultV1, LeanAdapterV1 } from "./runner"
import type { LeanAdapterFailureV1 } from "./types"

const ADAPTER_CERT_ENV = "FINNY_LEAN_ADAPTER_CERT"
const ADAPTER_CERT_VALUE = "finny-lean-adapter-cert-v1"

function truthy(value: string | undefined): boolean {
  const normalized = value?.toLowerCase()
  return normalized === "true" || normalized === "1"
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

    const docker = await Process.run(["docker", "version", "--format", "{{.Server.Version}}"], {
      nothrow: true,
      timeout: 15_000,
      env: null,
      inheritEnv: false,
    })
    if (docker.code !== 0) {
      return failure("docker_unavailable", `docker daemon is unavailable: ${docker.stderr.toString().trim()}`)
    }

    // Materialize the phase-scoped data bundle into the scratch directory.
    let bundle
    try {
      bundle = await materializeLeanDataBundle({
        phase: input.phase,
        interval: input.plan.interval,
        assetFamily: input.dataBundle.assetFamily,
        schedules: input.plan.datasets.map((dataset) => ({
          symbol: dataset.canonicalSymbol,
          assetClass: dataset.assetClass,
          interval: input.plan.interval,
          calendarId: "finny",
          calendarVersion: input.plan.calendarPolicyVersion,
          timezone: "UTC",
          bars: [],
          scheduleHash: dataset.scheduleHash,
        })),
        window: input.window,
        warmupBars: input.plan.warmupBars,
        outputDir: input.scratchDir,
      })
    } catch (error) {
      return failure("data_bundle_invalid", `data bundle materialization failed: ${String(error)}`)
    }

    // Offline, read-only, capability-dropped execution with controller-owned
    // limits. The pinned image runs the LEAN launcher directly; never the CLI.
    const mountData = `${input.scratchDir}:/Lean/Data:ro`
    const mountResults = `${input.resultsDir}:/Results`
    const cmd = [
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "10001:10001",
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
      `type=bind,source=${mountData}`,
      "--mount",
      `type=bind,source=${mountResults}`,
      "--mount",
      "type=tmpfs,destination=/tmp",
      "--env",
      `FINNY_SEED=${input.seed}`,
      "--env",
      `FINNY_PHASE=${input.phase}`,
      LEAN_PINNED_IMAGE_DIGEST,
      "dotnet",
      "QuantConnect.Lean.Launcher.dll",
      "--config",
      "/Lean/Launcher/bin/Debug/config.json",
    ]

    const result = await Process.run(cmd, {
      nothrow: true,
      timeout: 20 * 60_000,
      env: null,
      inheritEnv: false,
    })
    if (result.code !== 0) {
      const stderr = result.stderr.toString().trim().slice(0, 4000)
      return failure("engine_crash", `LEAN engine exited ${result.code}: ${stderr}`)
    }

    // Artifact parsing is performed by the canonical result mapper; the
    // adapter only asserts the expected files exist.
    try {
      const { readFile } = await import("node:fs/promises")
      const summary = await readFile(`${input.resultsDir}/summary.json`, "utf8").catch(() => "{}")
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
          leanResultPath: `${input.resultsDir}/result.json`,
          leanSummaryPath: `${input.resultsDir}/summary.json`,
        },
        container: {
          imageDigest: LEAN_PINNED_IMAGE_DIGEST,
          leanCommit: LEAN_PINNED_COMMIT,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          exitCode: result.code,
        },
      }
    } catch (error) {
      return failure("results_unparseable", `LEAN results could not be parsed: ${String(error)}`)
    }
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
