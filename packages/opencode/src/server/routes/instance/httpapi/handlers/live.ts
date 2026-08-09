import * as InstanceState from "@/effect/instance-state"
import { LiveRunner } from "@/live/runner"
import { RobinhoodExecution } from "@/live/robinhood-execution"
import { MCP } from "@/mcp"
import { Algorithm } from "@/algorithm"
import { GlobalBus } from "@/bus/global"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { controllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"
import { BuildWorkflowStore } from "@/algorithm/build-workflow/store"
import { readApproval, strictRunDir } from "@/backtest/run-integrity"
import { InstanceHttpApi } from "../api"
import { ConflictError, LiveRunNotFoundError, LiveRunStartError } from "../errors"
import type { RobinhoodPreflightPayload, StartPayload } from "../groups/live"

/**
 * Bridge LiveRunner's in-process listeners onto the GlobalBus so run updates
 * stream to TUI clients over the /global/event SSE channel. Registered once,
 * the first time the live route layer is built.
 *
 * We emit one `live.runs` event per project directory carrying that directory's
 * full run list — matching the TUI's existing `setStore("runs", runs)`
 * semantics and handling adds/removals/emptying naturally. Live runs tick
 * slowly (per bar), so full-snapshot payloads are acceptable for v1.
 */
let bridgeUnsubscribe: (() => void) | undefined
function ensureBridge() {
  if (bridgeUnsubscribe) return bridgeUnsubscribe
  let knownDirs = new Set<string>()
  bridgeUnsubscribe = LiveRunner.subscribeAll((runs) => {
    const byDir = new Map<string, LiveRunner.Run[]>()
    for (const run of runs) {
      const dir = run.directory ?? "global"
      const list = byDir.get(dir) ?? []
      list.push(run)
      byDir.set(dir, list)
    }
    // A directory whose runs all went away still needs one empty update so the
    // client clears its store.
    for (const dir of knownDirs) if (!byDir.has(dir)) byDir.set(dir, [])
    knownDirs = new Set(byDir.keys())
    for (const [directory, dirRuns] of byDir) {
      GlobalBus.emit("event", {
        directory,
        payload: { type: "live.runs", properties: { runs: dirRuns } },
      })
    }
  })
  return bridgeUnsubscribe
}

export const liveHandlers = HttpApiBuilder.group(InstanceHttpApi, "live", (handlers) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const mcp = yield* MCP.Service
    const runWorkflow = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
      Effect.runPromise(Effect.provideService(effect, Database.Service, database))
    const releaseBridge = ensureBridge()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseBridge()
        if (bridgeUnsubscribe === releaseBridge) bridgeUnsubscribe = undefined
      }),
    )

    const list = Effect.fn("LiveHttpApi.list")(function* () {
      const dir = yield* InstanceState.directory
      return LiveRunner.list().filter((r) => r.directory === dir)
    })

    const get = Effect.fn("LiveHttpApi.get")(function* (ctx: { params: { id: string } }) {
      const dir = yield* InstanceState.directory
      const run = LiveRunner.get(ctx.params.id)
      if (!run || run.directory !== dir) {
        return yield* Effect.fail(
          new LiveRunNotFoundError({ runID: ctx.params.id, message: `Live run not found: ${ctx.params.id}` }),
        )
      }
      return run
    })

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

    const robinhoodPreflight = Effect.fn("LiveHttpApi.robinhoodPreflight")(function* (ctx: {
      payload: typeof RobinhoodPreflightPayload.Type
    }) {
      const access = mcp.robinhoodBroker ? yield* mcp.robinhoodBroker() : undefined
      return yield* Effect.tryPromise({
        try: async () => {
          const algorithm = await Algorithm.getById(ctx.payload.algorithmId)
          if (!algorithm)
            throw new LiveRunner.StartRejectedError(`Algorithm ${ctx.payload.algorithmId} no longer exists.`)
          return RobinhoodExecution.preflight(
            {
              algorithm,
              runId: ctx.payload.runId,
              symbol: ctx.payload.symbol,
              interval: ctx.payload.interval,
              executionMode: ctx.payload.executionMode,
              accountProviderID: ctx.payload.accountProviderID,
              controllerApproval: await workflowAuthority(algorithm, ctx.payload.runId),
            },
            {
              access,
              // Deliberately absent until an authenticated tools/list capture
              // has been reviewed and checked in as an exact schema mapping.
              mapping: undefined,
            },
          )
        },
        catch: (error) => {
          if (error instanceof LiveRunner.StartRejectedError) {
            return new LiveRunStartError({ message: error.message })
          }
          throw error
        },
      })
    })

    const start = Effect.fn("LiveHttpApi.start")(function* (ctx: { payload: typeof StartPayload.Type }) {
      const dir = yield* InstanceState.directory
      return yield* Effect.tryPromise({
        try: async () => {
          const algorithm = await Algorithm.getById(ctx.payload.algorithm.algorithmId)
          if (!algorithm) {
            throw new LiveRunner.StartRejectedError(
              `Algorithm ${ctx.payload.algorithm.algorithmId} no longer exists; refresh before starting a run.`,
            )
          }
          const authority = await workflowAuthority(algorithm, ctx.payload.runId)
          return LiveRunner.start({
            algorithm,
            runId: ctx.payload.runId,
            symbol: ctx.payload.symbol,
            interval: ctx.payload.interval,
            accountProviderID: ctx.payload.accountProviderID,
            brokerKind: ctx.payload.brokerKind,
            directory: dir,
            controllerApproval: authority,
            activationReceipt: ctx.payload.activationReceipt,
            executionMode: ctx.payload.executionMode,
            challengeId: ctx.payload.challengeId,
            realMoneyAcknowledgement: ctx.payload.realMoneyAcknowledgement,
          })
        },
        catch: (error) => {
          if (error instanceof LiveRunner.StartRejectedError) {
            return new LiveRunStartError({ message: error.message })
          }
          throw error
        },
      })
    })

    const assertRunInDirectory = Effect.fn("LiveHttpApi.assertRunInDirectory")(function* (id: string) {
      const dir = yield* InstanceState.directory
      const run = LiveRunner.get(id)
      if (!run || run.directory !== dir) {
        return yield* Effect.fail(new LiveRunNotFoundError({ runID: id, message: `Live run not found: ${id}` }))
      }
      return run
    })

    const stop = Effect.fn("LiveHttpApi.stop")(function* (ctx: { params: { id: string } }) {
      yield* assertRunInDirectory(ctx.params.id)
      yield* Effect.promise(() => LiveRunner.stop(ctx.params.id))
      return true
    })

    const remove = Effect.fn("LiveHttpApi.remove")(function* (ctx: { params: { id: string } }) {
      const run = yield* assertRunInDirectory(ctx.params.id)
      if (!LiveRunner.canRemoveStatus(run.status)) {
        return yield* Effect.fail(
          new ConflictError({
            resource: `live:${ctx.params.id}`,
            message: `Live run ${ctx.params.id} is ${run.status}. Stop it before removing it.`,
          }),
        )
      }
      LiveRunner.remove(ctx.params.id)
      return true
    })

    return handlers
      .handle("robinhoodPreflight", robinhoodPreflight)
      .handle("list", list)
      .handle("get", get)
      .handle("start", start)
      .handle("stop", stop)
      .handle("remove", remove)
  }),
)
