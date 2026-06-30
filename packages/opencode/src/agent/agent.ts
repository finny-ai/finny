import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeRuntime } from "@/effect/run-service"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Config } from "@/config/config"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Provider } from "@/provider/provider"

import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_FINNY_BUILD_RAW from "./prompt/finny-build.txt"
import PROMPT_FINNY_RESEARCH_RAW from "./prompt/finny-research.txt"
import PROMPT_FINNY_CHAT_RAW from "./prompt/finny-chat.txt"
import PROMPT_FINNY_PORTFOLIO_BUILDER_RAW from "./prompt/finny-portfolio-builder.txt"
import PROMPT_FINNY_DATA_EXTRACTOR from "./prompt/finny-data-extractor.txt"
import PROMPT_FINNY_NEWS_AGENT from "./prompt/finny-news-agent.txt"
import PROMPT_FINNY_SEC_AGENT from "./prompt/finny-sec-agent.txt"
import PROMPT_FINNY_SENTIMENT_AGENT from "./prompt/finny-sentiment-agent.txt"
import { renderPromptWithSymbols } from "../data/symbols"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { existsSync } from "fs"
import { algosRoot } from "@finny-ai/core/algo"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"

const PROMPT_FINNY_BUILD = renderPromptWithSymbols(PROMPT_FINNY_BUILD_RAW)
const PROMPT_FINNY_RESEARCH = renderPromptWithSymbols(PROMPT_FINNY_RESEARCH_RAW)
const PROMPT_FINNY_CHAT = renderPromptWithSymbols(PROMPT_FINNY_CHAT_RAW)
const PROMPT_FINNY_PORTFOLIO_BUILDER = renderPromptWithSymbols(PROMPT_FINNY_PORTFOLIO_BUILDER_RAW)
type PermissionConfig = Parameters<typeof Permission.fromConfig>[0]

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: PermissionV1.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelV2.ID,
      providerID: ProviderV2.ID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
}).annotate({ identifier: "Agent" })
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

const GeneratedAgent = Schema.Struct({
  identifier: Schema.String,
  whenToUse: Schema.String,
  systemPrompt: Schema.String,
})

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultInfo: () => Effect.Effect<Info>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  }) => Effect.Effect<
    {
      identifier: string
      whenToUse: string
      systemPrompt: string
    },
    Provider.DefaultModelError
  >
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service
    const locations = yield* LocationServiceMap

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const referenceDirs = yield* Effect.gen(function* () {
          yield* (yield* PluginBoot.Service).wait()
          return (yield* (yield* Reference.Service).list()).map((reference) => reference.path)
        }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(ctx.directory) }))))
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
          ...referenceDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})

        const finnyFileSystemSandbox = Permission.fromConfig({
          read: "deny",
          edit: "deny",
          glob: "deny",
          grep: "deny",
          list: "deny",
          bash: "deny",
          shell: "deny",
          external_directory: "deny",
          websearch: "deny",
        })

        function finnyToolBundle(tools: string[], taskAgents: string[] = []) {
          const permission: PermissionConfig = { "*": "deny" }
          for (const tool of tools) permission[tool] = "allow"
          if (taskAgents.length > 0) {
            permission.task = {
              "*": "deny",
              ...Object.fromEntries(taskAgents.map((agent) => [agent, "allow"])),
            }
          }
          return Permission.fromConfig(permission)
        }

        const finnyBuildTools = [
          "question",
          "task",
          "finny_algorithm_scaffold",
          "finny_algorithm_save",
          "finny_algorithm_validate",
          "finny_algorithm_get",
          "finny_algorithm_list",
          "finny_algorithm_versions",
          "finny_algorithm_export",
          "finny_algorithm_set_params",
          "finny_backtest_run",
          "finny_backtest_walkforward",
          "finny_portfolio_backtest",
          "finny_get_quote",
          "webfetch",
          "skill",
        ]
        const finnyResearchTools = [
          "question",
          "task",
          "finny_get_quote",
          "finny_get_history",
          "webfetch",
          "finny_algorithm_set_params",
          "skill",
        ]
        const finnyChatTools = [
          "question",
          "task",
          "finny_get_quote",
          "finny_get_history",
          "finny_algorithm_list",
          "finny_algorithm_get",
          "finny_backtest_history",
          "webfetch",
          "skill",
        ]

        function finnyAlgoRoot() {
          const starts = [...new Set([ctx.directory, ctx.worktree].filter((item) => item && item !== "/"))]
          for (const start of starts) {
            let current = path.resolve(start)
            while (true) {
              if (existsSync(path.join(current, "algos/_template/README.md"))) return current
              const next = path.dirname(current)
              if (next === current) break
              current = next
            }
          }
          return ctx.worktree
        }

        function finnyWorkspacePatterns(pattern: string): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const root = finnyAlgoRoot()
          const variants = pattern.endsWith("/*") ? [pattern, pattern.slice(0, -2)] : [pattern]
          const patterns = variants.flatMap((p) => {
            const out = [p, path.join(ctx.directory, p)]
            if (ctx.worktree !== "/" && ctx.worktree !== ctx.directory) out.push(path.join(ctx.worktree, p))
            if (root !== "/" && root !== ctx.directory && root !== ctx.worktree) out.push(path.join(root, p))
            return out
          })
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }

        const finnyTemplateReadAccess = Permission.fromConfig({
          read: {
            ...finnyWorkspacePatterns("algos/_template/*"),
            ...finnyWorkspacePatterns("data-agent/instructions.md"),
          },
          external_directory: {
            ...finnyWorkspacePatterns("algos/_template/*"),
            ...finnyWorkspacePatterns("data-agent/instructions.md"),
          },
        })
        const finnyTemplateNewsAccess = Permission.fromConfig({
          read: {
            ...finnyWorkspacePatterns("algos/_template/data/news/*"),
          },
          edit: {
            ...finnyWorkspacePatterns("algos/_template/data/news/*"),
          },
          external_directory: {
            ...finnyWorkspacePatterns("algos/_template/data/news/*"),
          },
        })
        const finnyTemplateMissionReadAccess = Permission.fromConfig({
          read: {
            ...finnyWorkspacePatterns("algos/_template/mission.md"),
          },
          external_directory: {
            ...finnyWorkspacePatterns("algos/_template/mission.md"),
          },
        })
        function finnyUserAlgoNewsPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const root = algosRoot()
          const patterns = [
            path.join(root, "*/data/news/*"),
            path.join(root, "*/data/news/*/*"),
            path.join(root, "*/data/news/*/*/*"),
            path.join(root, "*/data/news"),
          ]
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        function finnyUserAlgoDataPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const root = algosRoot()
          const patterns = [
            path.join(root, "*/data/*"),
            path.join(root, "*/data/*/*"),
            path.join(root, "*/data/*/*/*"),
            path.join(root, "*/data/*/*/*/*"),
            path.join(root, "*/data"),
          ]
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        function finnyUserAlgoSecPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const root = algosRoot()
          const patterns = [path.join(root, "*/data/sec/*"), path.join(root, "*/data/sec")]
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        function finnyUserAlgoSentimentPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const root = algosRoot()
          const patterns = [
            path.join(root, "*/data/sentiment/body/*"),
            path.join(root, "*/data/sentiment/body"),
          ]
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        const finnySessionDataReadAccess = Permission.fromConfig({
          read: finnyUserAlgoDataPatterns(),
          external_directory: finnyUserAlgoDataPatterns(),
        })
        const finnySessionNewsAccess = Permission.fromConfig({
          read: finnyUserAlgoNewsPatterns(),
          write: finnyUserAlgoNewsPatterns(),
          edit: finnyUserAlgoNewsPatterns(),
          external_directory: finnyUserAlgoNewsPatterns(),
        })
        const finnySessionSecAccess = Permission.fromConfig({
          read: finnyUserAlgoSecPatterns(),
          write: finnyUserAlgoSecPatterns(),
          edit: finnyUserAlgoSecPatterns(),
          external_directory: finnyUserAlgoSecPatterns(),
        })
        const finnySessionSentimentAccess = Permission.fromConfig({
          read: finnyUserAlgoSentimentPatterns(),
          write: finnyUserAlgoSentimentPatterns(),
          edit: finnyUserAlgoSentimentPatterns(),
          external_directory: finnyUserAlgoSentimentPatterns(),
        })
        const finnyDataAgentAccess = Permission.fromConfig({
          read: "allow",
          external_directory: "allow",
        })
        const finnySecretReadDeny = Permission.fromConfig({
          read: {
            "*.env": "deny",
            "*.env.*": "deny",
            "**/.env": "deny",
            "**/.env.*": "deny",
          },
        })
        const agents: Record<string, Info> = {
          build: {
            name: "build",
            description: "Build mode. Generates trading algorithms immediately based on your specifications.",
            color: "#f97316",
            options: {},
            prompt: PROMPT_FINNY_BUILD,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(finnyBuildTools, [
                "data_extractor",
                "news_agent",
                "researcher",
                "sec_agent",
                "sentiment_agent",
              ]),
              Permission.fromConfig({
                question: "allow",
              }),
              user,
              finnyTemplateReadAccess,
              finnySessionDataReadAccess,
            ),
            mode: "primary",
            native: true,
          },
          research: {
            name: "research",
            description: "Research mode. Asks clarifying questions, gathers data, and then builds.",
            color: "#a78bfa",
            options: {},
            prompt: PROMPT_FINNY_RESEARCH,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(finnyResearchTools, ["data_extractor", "news_agent", "researcher"]),
              user,
            ),
            mode: "primary",
            native: true,
            hidden: false,
          },
          chat: {
            name: "chat",
            description: "Chat mode. Conversational assistant for markets, strategies, and platform help.",
            color: "#22c55e",
            options: {},
            prompt: PROMPT_FINNY_CHAT,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(finnyChatTools, ["news_agent", "researcher"]),
              user,
            ),
            mode: "primary",
            native: true,
          },
          portfolio_builder: {
            name: "portfolio_builder",
            description:
              "Portfolio Builder. Designs a diversified investment plan sized to funds, horizon, and risk. Recommendation only; does not execute trades.",
            color: "#eab308",
            options: {},
            prompt: PROMPT_FINNY_PORTFOLIO_BUILDER,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              user,
              Permission.fromConfig({
                question: "allow",
                edit: "deny",
                write: "deny",
                patch: "deny",
              }),
            ),
            mode: "primary",
            native: true,
            hidden: true,
          },
          general: {
            name: "general",
            description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                todowrite: "deny",
              }),
              user,
            ),
            options: {},
            mode: "subagent",
            native: true,
          },
          explore: {
            name: "explore",
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
            prompt: PROMPT_EXPLORE,
            options: {},
            mode: "subagent",
            native: true,
          },
          data_extractor: {
            name: "data_extractor",
            description:
              "Data extraction subagent. Reads repo-level data-agent instructions, fetches or transforms data " +
              "through host bash, writes files into the active algorithm's data/ folder, and returns a structured " +
              "digest or artifact summary — not raw bars. Use this when the main agent needs market data for strategy " +
              "design, backtesting, or analysis.",
            color: "#06b6d4",
            options: {},
            prompt: PROMPT_FINNY_DATA_EXTRACTOR,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(["bash", "read", "skill"]),
              user,
              finnyDataAgentAccess,
              finnySecretReadDeny,
              finnyTemplateMissionReadAccess,
            ),
            mode: "subagent",
            native: true,
          },
          news_agent: {
            name: "news_agent",
            description:
              "News subagent. Checks current news plus execution, provenance, and risk context, " +
              "then returns a concise cited validation brief for the parent agent.",
            color: "#8b5cf6",
            options: {},
            prompt: PROMPT_FINNY_NEWS_AGENT,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(["webfetch", "websearch", "finny_discord_read"]),
              user,
              finnyTemplateNewsAccess,
              finnyTemplateMissionReadAccess,
              finnySessionNewsAccess,
            ),
            mode: "subagent",
            native: true,
          },
          researcher: {
            name: "researcher",
            description:
              "Compatibility alias for news_agent. Prefer task(subagent_type=\"news_agent\") for current news/context work.",
            color: "#8b5cf6",
            options: {},
            prompt: PROMPT_FINNY_NEWS_AGENT,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(["webfetch", "websearch", "finny_discord_read"]),
              user,
              finnyTemplateNewsAccess,
              finnyTemplateMissionReadAccess,
              finnySessionNewsAccess,
            ),
            mode: "subagent",
            native: true,
            hidden: true,
          },
          sec_agent: {
            name: "sec_agent",
            description:
              "SEC EDGAR public-records subagent. Resolves CIK, fetches insider/ownership/institutional filings, " +
              "writes normalized artifacts under the active algorithm data/sec/ folder, and returns a concise " +
              "holdings/filings analysis. Use when Build needs SEC evidence for trading or investment reasoning.",
            color: "#0ea5e9",
            options: {},
            prompt: PROMPT_FINNY_SEC_AGENT,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(["webfetch", "websearch", "bash"]),
              user,
              finnySessionSecAccess,
              finnySecretReadDeny,
            ),
            mode: "subagent",
            native: true,
            hidden: true,
          },
          sentiment_agent: {
            name: "sentiment_agent",
            description:
              "Social sentiment subagent. Fetches free/keyless social sentiment and attention sources, writes " +
              "aggregate-only artifacts under the active algorithm data/sentiment/body/ folder, and returns a " +
              "concise crowd-positioning brief. Use when Build needs retail attention, meme-flow, crowding, " +
              "sentiment-reversal, or social-catalyst evidence.",
            color: "#ec4899",
            options: {},
            prompt: PROMPT_FINNY_SENTIMENT_AGENT,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(["webfetch", "websearch", "bash"]),
              user,
              finnySessionSentimentAccess,
              finnySecretReadDeny,
              finnyTemplateMissionReadAccess,
            ),
            mode: "subagent",
            native: true,
            hidden: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const primaryOrder = new Map([
          ["build", 0],
          ["research", 1],
          ["chat", 2],
          ["portfolio_builder", 3],
        ])

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
              [(x) => primaryOrder.get(x.name) ?? 100, "asc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true && agent.name !== "research")
              throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visiblePreferred = ["build", "chat", "research"]
            .map((name) => agents[name])
            .find((a) => a && a.mode !== "subagent" && a.hidden !== true)
          if (visiblePreferred) return visiblePreferred
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          return (yield* defaultInfo()).name
        })

        return {
          get,
          list,
          defaultInfo,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultInfo: Effect.fn("Agent.defaultInfo")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultInfo())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: Object.assign(
            Schema.toStandardSchemaV1(GeneratedAgent),
            Schema.toStandardJSONSchemaV1(GeneratedAgent),
          ),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
)

const runtime = makeRuntime(Service, defaultLayer)

export const get = (...args: Parameters<Interface["get"]>) => runtime.runPromise((s) => s.get(...args))
export const list = (...args: Parameters<Interface["list"]>) => runtime.runPromise((s) => s.list(...args))

const locationServiceMapNode = LayerNode.make(LocationServiceMap.layer, [])

export const node = LayerNode.make(layer, [
  Config.node,
  Auth.node,
  Plugin.node,
  Skill.node,
  Provider.node,
  locationServiceMapNode,
])

export * as Agent from "./agent"
