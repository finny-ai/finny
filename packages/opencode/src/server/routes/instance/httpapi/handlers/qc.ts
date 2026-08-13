import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import crypto from "node:crypto"
import {
  connectQcCredentials,
  disconnectQcCredentials,
  qcConnectionState,
  resolveQcMode,
} from "@/integration/quantconnect"
import {
  attachProject,
  listLinkableProjects,
  refreshLinkSync,
  remoteSourceFiles,
  resolveDrift,
  syncBeforeRun,
  unlinkProject,
} from "@/integration/qc-sync"
import { getProjectLink, setConfiguredQcMode } from "@/integration/qc-store"
import * as QcExecution from "@/integration/qc-execution"
import {
  runQcCompositeQualification,
  writeQcCompositeEvidence,
  type QcLocalRunOutcome,
} from "@/integration/qc-composite"
import { runtimeProfileV1 } from "@/backtest/lean/contracts"
import { readRemoteContents, materializeRemoteFilesToAlgorithm } from "@/integration/qc-import"
import { Algorithm } from "@/algorithm"
import { BacktestRunner } from "@/backtest/runner"
import { readApproval, strictRunDir } from "@/backtest/run-integrity"
import { controllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import { Database } from "@opencode-ai/core/database/database"
import type { InstanceHttpApiType } from "../api"
import * as InstanceState from "@/effect/instance-state"

export function qcHandlers(api: InstanceHttpApiType) {
  return HttpApiBuilder.group(api, "qc", (handlers) =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const runWorkflow = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
        Effect.runPromise(Effect.provideService(effect, Database.Service, database))

      const workflowAuthority = async (algorithm: Algorithm.Info, runId: string) => {
        const approval = await readApproval(strictRunDir(algorithm, runId), "paper_eligible")
        const workflow = approval?.workflowId ? await runWorkflow(BuildWorkflowStore.get(approval.workflowId)) : undefined
        return approval
          ? controllerPaperApproval(workflow, {
              algorithmId: algorithm.algorithmId,
              algorithmVersion: algorithm.version,
              runId,
              identityHash: approval.identityHash,
            })
          : undefined
      }

      const syncStateFor = async (algorithm: Algorithm.Info) => {
        const link = await getProjectLink(algorithm.algorithmId)
        if (!link) return { linked: false, drift: [] }
        const decision = await syncBeforeRun(algorithm)
        const refreshed = await getProjectLink(algorithm.algorithmId)
        return {
          linked: true,
          state: refreshed?.sync.state,
          projectId: link.projectId,
          projectName: link.projectName,
          language: link.language,
          drift: decision.drift ?? refreshed?.sync.driftDetail ?? [],
          ...(decision.action ? { action: decision.action } : {}),
        }
      }

      return handlers
        .handle("connect", ({ payload }) =>
          Effect.tryPromise({
            try: () => connectQcCredentials(payload),
            catch: () => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("status", () => Effect.promise(() => qcConnectionState()))
        .handle("mode", () => Effect.promise(() => resolveQcMode()))
        .handle("setMode", ({ payload }) =>
          Effect.tryPromise({
            try: async () => {
              await setConfiguredQcMode(payload.mode)
              return resolveQcMode()
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("disconnect", () =>
          Effect.gen(function* () {
            yield* Effect.promise(() => disconnectQcCredentials())
            return yield* Effect.promise(() => qcConnectionState())
          }),
        )
        .handle("projects", () => Effect.promise(() => listLinkableProjects()))
        .handle("syncState", ({ params }) =>
          Effect.tryPromise({
            try: async () => {
              const algorithm = await Algorithm.getById(params.algorithmId)
              if (!algorithm) throw new Error("algorithm not found")
              return syncStateFor(algorithm)
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("link", ({ payload }) =>
          Effect.tryPromise({
            try: async () => {
              const algorithm = await Algorithm.getById(payload.algorithmId)
              if (!algorithm) throw new Error("algorithm not found")
              await attachProject({
                algorithm,
                projectId: payload.projectId,
                mode: payload.mode,
              })
              return syncStateFor(algorithm)
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("importProject", ({ payload }) =>
          Effect.tryPromise({
            try: async () => {
              const contents = await readRemoteContents(payload.projectId)
              const project = (await listLinkableProjects()).find((item) => item.projectId === payload.projectId)
              if (!project) throw new Error("QuantConnect project not found")
              const main =
                contents.find((file) => /^(main\.py|Main\.cs)$/.test(file.path)) ??
                contents.find((file) => file.path.endsWith(".py")) ??
                contents.find((file) => file.path.endsWith(".cs"))
              if (!main) throw new Error("QuantConnect project has no runnable main source file")
              const algorithm = await Algorithm.save({
                name: payload.algorithmName ?? project.name,
                code: main.content,
                language: project.language === "csharp" ? "csharp" : "python",
                config: JSON.stringify({
                  runtime: { profile: runtimeProfileV1("qc_cloud") },
                }),
                saveMode: "new",
              })
              await materializeRemoteFilesToAlgorithm(algorithm, contents)
              await attachProject({
                algorithm,
                projectId: payload.projectId,
                projectName: project.name,
                language: project.language,
                leanVersionId: 0,
                mode: "import_remote",
              })
              return {
                algorithmId: algorithm.algorithmId,
                algorithmName: algorithm.name,
                version: algorithm.version,
                projectId: payload.projectId,
              }
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("refreshSync", ({ params }) =>
          Effect.tryPromise({
            try: async () => {
              const algorithm = await Algorithm.getById(params.algorithmId)
              if (!algorithm) throw new Error("algorithm not found")
              return syncStateFor(algorithm)
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("resolveDrift", ({ params, payload }) =>
          Effect.tryPromise({
            try: async () => {
              const algorithm = await Algorithm.getById(params.algorithmId)
              if (!algorithm) throw new Error("algorithm not found")
              const decision = await resolveDrift({ algorithm, direction: payload.direction })
              if (!decision.ok) throw new Error(decision.error ?? "drift resolution failed")
              return syncStateFor(algorithm)
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("unlink", ({ params }) =>
          Effect.tryPromise({
            try: async () => unlinkProject(params.algorithmId),
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("deployments", () =>
          Effect.promise(async () =>
            (await import("@/integration/qc-store")).listDeployments().then((records) =>
              records.map((record) => ({
                deploymentId: record.deploymentId,
                algorithmId: record.algorithmId,
                algorithmName: record.algorithmName,
                projectId: record.projectId,
                status: record.status,
                ownership: record.ownership,
                ...(record.qcStatus ? { qcStatus: record.qcStatus } : {}),
                ...(record.liveUrl ? { liveUrl: record.liveUrl } : {}),
                ...(record.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt } : {}),
                ...(record.error ? { error: record.error } : {}),
              })),
            ),
          ),
        )
        .handle("deploy", ({ payload }) =>
          Effect.tryPromise({
            try: async () => {
              const algorithm = await Algorithm.getById(payload.algorithmId)
              if (!algorithm) throw new Error("algorithm not found")
              const authority = await workflowAuthority(algorithm, payload.runId)
              return QcExecution.startPaperDeployment({
                algorithm,
                runId: payload.runId,
                authority,
                ...(payload.nodeId ? { nodeId: payload.nodeId } : {}),
                ...(payload.capital ? { capital: payload.capital } : {}),
              })
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
        .handle("stopDeployment", ({ params }) =>
          Effect.promise(() => QcExecution.stopDeployment(params.deploymentId)),
        )
        .handle("liquidateDeployment", ({ params }) =>
          Effect.promise(() => QcExecution.liquidateDeployment(params.deploymentId)),
        )
        .handle("compositeBacktest", ({ payload }) =>
          Effect.tryPromise({
            try: async () => {
              const algorithm = await Algorithm.getById(payload.algorithmId)
              if (!algorithm) throw new Error("algorithm not found")
              const link = await getProjectLink(algorithm.algorithmId)
              if (!link) throw new Error("algorithm is not linked to a QuantConnect project")
              let config: Record<string, any> = {}
              try {
                config = JSON.parse(algorithm.config ?? "{}")
              } catch {}
              const interval = payload.interval ?? (typeof config.interval === "string" ? config.interval : "5m")
              const capital =
                payload.capital ??
                (typeof config.equity_usd === "number" ? config.equity_usd : 10000)
              const end = payload.endDate ?? new Date().toISOString().slice(0, 10)
              const start = payload.startDate ?? new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10)
              const result = await BacktestRunner.run({
                algorithm,
                duration: "6m",
                interval,
                capital: String(capital),
                startDate: start,
                endDate: end,
                dataQualityMode: "strict",
                robustness: { monteCarloPaths: 500, regimes: true, walkForwardFolds: 0, priorSelectionTrials: 0, currentSelectionTrials: 1 },
                dataSource: { kind: "provider_fetch" },
              })
              if (!result.ok) return { ok: false, error: result.error }
              const r = result.results
              const localRunId = r.runId ?? ""
              let identityHash = ""
              let runtimeHash = ""
              if (localRunId) {
                try {
                  const runJson = await (await import("@/backtest/run-integrity-core")).readJson<{
                    identityHash?: string
                    identity?: { runtimeIdentity?: { runtimeHash?: string; adapterHash?: string } }
                  }>({ file: `${strictRunDir(algorithm, localRunId)}/run.json` })
                  identityHash = runJson?.identityHash ?? ""
                  runtimeHash =
                    runJson?.identity?.runtimeIdentity?.runtimeHash ??
                    runJson?.identity?.runtimeIdentity?.adapterHash ??
                    ""
                } catch {}
              }
              const local: QcLocalRunOutcome = {
                ok: true,
                runId: localRunId,
                identityHash,
                runtimeHash,
                engine: link.language === "csharp" ? "lean_csharp" : "lean_python",
                verdict: r.totalReturn > 0 && r.sharpeRatio > 0 ? "candidate" : "failed",
                metrics: { totalReturn: r.totalReturn, sharpe: r.sharpeRatio, maxDrawdown: r.maxDrawdown, totalTrades: r.totalTrades },
              }
              const composite = await runQcCompositeQualification({
                algorithm,
                interval,
                capital,
                startDate: start,
                endDate: end,
                local,
              })
              if (!composite.ok || !composite.identity) {
                return { ok: false, error: composite.error ?? "QC Cloud composite leg failed" }
              }
              if (localRunId) {
                await writeQcCompositeEvidence({
                  runDir: strictRunDir(algorithm, localRunId),
                  identity: composite.identity,
                  outcome: composite,
                })
              }
              return {
                ok: true,
                projectId: composite.projectId,
                ...(composite.backtestId ? { backtestId: composite.backtestId } : {}),
                ...(composite.backtestUrl ? { backtestUrl: composite.backtestUrl } : {}),
                compositeVerdict: composite.compositeVerdict,
                canonical: composite.canonical as unknown as Record<string, unknown>,
                cloudGates: composite.cloudGates,
              }
            },
            catch: (error) => new HttpApiError.BadRequest({}),
          }),
        )
    }),
  )
}
