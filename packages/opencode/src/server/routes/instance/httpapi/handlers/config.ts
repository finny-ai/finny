import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import fs from "node:fs/promises"
import path from "path"
import { clearFinnyHome, getFinnyHomeInfo, setFinnyHome } from "@finny-ai/core/prefs"
import { DATA_AGENT_INSTRUCTIONS_PATH } from "../groups/config-constants"
import { FinnyHomeApiError } from "../groups/config"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const providerSvc = yield* Provider.Service
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    const providers = Effect.fn("ConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })

    const finnyHome = Effect.fn("ConfigHttpApi.finnyHome")(function* () {
      return yield* Effect.promise(() => getFinnyHomeInfo())
    })

    const updateFinnyHome = Effect.fn("ConfigHttpApi.updateFinnyHome")(function* (ctx) {
      const result = yield* Effect.tryPromise({
        try: () => (ctx.payload.path === null ? clearFinnyHome() : setFinnyHome(ctx.payload.path)),
        catch: (err) =>
          new FinnyHomeApiError({
            name: "FinnyHomeError",
            data: { message: err instanceof Error ? err.message : String(err) },
          }),
      })
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return result
    })

    const instructionsPath = Effect.fn("ConfigHttpApi.dataAgentInstructionsPath")(function* () {
      const ctx = yield* InstanceState.context
      const repoRoot = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      return path.resolve(repoRoot, DATA_AGENT_INSTRUCTIONS_PATH)
    })

    const readInstructions = Effect.fn("ConfigHttpApi.readDataAgentInstructions")(function* () {
      const absolute = yield* instructionsPath()
      return yield* Effect.promise(async () => {
        try {
          return {
            path: DATA_AGENT_INSTRUCTIONS_PATH,
            absolute_path: absolute,
            content: await fs.readFile(absolute, "utf8"),
            exists: true,
          } as const
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
          return {
            path: DATA_AGENT_INSTRUCTIONS_PATH,
            absolute_path: absolute,
            content: "",
            exists: false,
          } as const
        }
      })
    })

    const dataAgentInstructions = Effect.fn("ConfigHttpApi.dataAgentInstructions")(function* () {
      return yield* readInstructions()
    })

    const updateDataAgentInstructions = Effect.fn("ConfigHttpApi.updateDataAgentInstructions")(function* (ctx) {
      const absolute = yield* instructionsPath()
      yield* Effect.promise(async () => {
        await fs.mkdir(path.dirname(absolute), { recursive: true })
        await fs.writeFile(absolute, ctx.payload.content, "utf8")
      })
      return yield* readInstructions()
    })

    return handlers
      .handle("get", get)
      .handle("update", update)
      .handle("providers", providers)
      .handle("finnyHome", finnyHome)
      .handle("updateFinnyHome", updateFinnyHome)
      .handle("dataAgentInstructions", dataAgentInstructions)
      .handle("updateDataAgentInstructions", updateDataAgentInstructions)
  }),
)
