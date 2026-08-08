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
import PROMPT_FINNY_RAW from "./prompt/finny.txt"
import PROMPT_FINNY_BUILD_RAW from "./prompt/finny-build.txt"
import PROMPT_FINNY_RESEARCH_RAW from "./prompt/finny-research.txt"
import PROMPT_FINNY_CHAT_RAW from "./prompt/finny-chat.txt"
import PROMPT_FINNY_PORTFOLIO_BUILDER_RAW from "./prompt/finny-portfolio-builder.txt"
import PROMPT_FINNY_DATA_EXTRACTOR from "./prompt/finny-data-extractor.txt"
import PROMPT_FINNY_NEWS_AGENT from "./prompt/finny-news-agent.txt"
import PROMPT_FINNY_SEC_AGENT from "./prompt/finny-sec-agent.txt"
import PROMPT_FINNY_SENTIMENT_AGENT from "./prompt/finny-sentiment-agent.txt"
import PROMPT_FINNY_FUND_MANAGER_RAW from "./prompt/finny-fund-manager.txt"
import PROMPT_FINNY_FUND_SPECIALIST_RAW from "./prompt/finny-fund-specialist.txt"
import { renderPromptWithSymbols } from "../data/symbols"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { existsSync, realpathSync } from "fs"
import { algosRoot } from "@finny-ai/core/algo"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { modelTelemetry } from "@/session/llm/telemetry"
import { AbsolutePath, type DeepMutable } from "@opencode-ai/core/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { Reference } from "@opencode-ai/core/reference"
import { Location } from "@opencode-ai/core/location"
import {
  FUND_MANAGER_AGENT,
  FUND_RUNTIME_MODEL,
  FUND_SPECIALIST_AGENTS,
  fundAgentConfigError,
  type FundSpecialistAgent,
} from "./fund-policy"

const PROMPT_FINNY = renderPromptWithSymbols(PROMPT_FINNY_RAW)
const PROMPT_FINNY_BUILD = renderPromptWithSymbols(PROMPT_FINNY_BUILD_RAW)
const PROMPT_FINNY_RESEARCH = renderPromptWithSymbols(PROMPT_FINNY_RESEARCH_RAW)
const PROMPT_FINNY_CHAT = renderPromptWithSymbols(PROMPT_FINNY_CHAT_RAW)
const PROMPT_FINNY_PORTFOLIO_BUILDER = renderPromptWithSymbols(PROMPT_FINNY_PORTFOLIO_BUILDER_RAW)
const PROMPT_FINNY_FUND_MANAGER = renderPromptWithSymbols(PROMPT_FINNY_FUND_MANAGER_RAW)
const PROMPT_FINNY_FUND_SPECIALIST = renderPromptWithSymbols(PROMPT_FINNY_FUND_SPECIALIST_RAW)
type PermissionConfig = Parameters<typeof Permission.fromConfig>[0]

const BUILTIN_AGENT_ALIASES: Record<string, string> = {
  "finny-build": "build",
  "finny-research": "research",
  "finny-chat": "chat",
}

export function resolveBuiltInAgentAlias(name: string): string {
  return BUILTIN_AGENT_ALIASES[name] ?? name
}

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
        const finnyPaperApprovalPrompt = Permission.fromConfig({
          finny_paper_approve: "ask",
        })
        // A mechanical clamp inside finny_workspace_edit applies silently; only a
        // window/interval change the user has to own reaches this permission, and
        // the tool bundle's blanket deny would otherwise turn that into a dead end.
        const finnyWorkspaceEditPrompt = Permission.fromConfig({
          finny_workspace_edit_identity: "ask",
        })

        const finnyBuildTools = [
          "question",
          "task",
          "finny_strategy_context_wait",
          "finny_workspace_prepare",
          "finny_algorithm_scaffold",
          "finny_algorithm_save",
          "finny_algorithm_validate",
          "finny_algorithm_get",
          "finny_algorithm_list",
          "finny_algorithm_versions",
          "finny_algorithm_export",
          "finny_algorithm_set_params",
          "finny_workflow_request_approval",
          "finny_workflow_invalidate_candidate",
          "finny_backtest",
          "qualify_candidate",
          "finny_review_packet",
          "finny_portfolio_backtest",
          "finny_get_quote",
          "webfetch",
          "skill",
        ]
        const finnyModeTools = [
          "question",
          "task",
          "finny_strategy_context_wait",
          "bash",
          "read",
          "write",
          "edit",
          "todowrite",
          "finny_workspace_prepare",
          "finny_workspace_edit",
          "finny_algorithm_scaffold",
          "finny_algorithm_save",
          "finny_algorithm_get",
          "finny_algorithm_list",
          "finny_algorithm_versions",
          "finny_algorithm_export",
          "finny_algorithm_set_params",
          "finny_workflow_request_approval",
          "finny_workflow_invalidate_candidate",
          "finny_backtest",
          "qualify_candidate",
          "finny_review_packet",
          "finny_portfolio_backtest",
          "finny_get_quote",
          "finny_get_history",
          "webfetch",
          "websearch",
          "skill",
        ]
        const finnyResearchTools = [
          "question",
          "task",
          "finny_workspace_prepare",
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
        const fundManagerTools = ["task", "finny_fund_action_draft", "finny_fund_action_propose"]
        const fundSpecialistTools = ["finny_fund_specialist_report"]

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
        function canonicalPathVariants(input: string): string[] {
          const resolved = path.resolve(input)
          const variants = [resolved]
          let existing = resolved
          const suffix: string[] = []
          while (!existsSync(existing)) {
            const parent = path.dirname(existing)
            if (parent === existing) break
            suffix.unshift(path.basename(existing))
            existing = parent
          }
          try {
            variants.push(path.join(realpathSync.native(existing), ...suffix))
          } catch {
            // Keep the lexical path when no existing ancestor can be resolved.
          }
          return [...new Set(variants)]
        }

        function finnyUserAlgoPatterns(suffixes: string[]): string[] {
          const absolute = canonicalPathVariants(algosRoot()).flatMap((root) =>
            suffixes.map((suffix) => path.join(root, suffix)),
          )
          // File mutation tools ask permission with paths relative to the
          // instance worktree, while external-directory checks use absolute
          // paths. Include both spellings, plus realpath aliases such as
          // macOS /tmp -> /private/tmp, so the narrow workspace policy is the
          // same at catalog time and execution time.
          const anchors = [...new Set([ctx.worktree, ctx.directory].flatMap(canonicalPathVariants))]
          return [
            ...new Set([
              ...absolute,
              ...absolute.flatMap((pattern) => anchors.map((root) => path.relative(root, pattern))),
            ]),
          ]
        }

        function finnyUserAlgoNewsReadPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const patterns = finnyUserAlgoPatterns([
            "*/data/news/*",
            "*/data/news/*/*",
            "*/data/news/*/*/*",
            "*/data/news",
          ])
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        function finnyUserAlgoNewsWritePatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const allow = finnyUserAlgoPatterns(["*/data/news/*", "*/data/news"])
          const deny = finnyUserAlgoPatterns([
            "*/data/news/body",
            "*/data/news/body/*",
            "*/data/news/headlines",
            "*/data/news/headlines/*",
          ])
          return {
            ...Object.fromEntries([...new Set(allow)].map((item) => [item, "allow" as const])),
            ...Object.fromEntries([...new Set(deny)].map((item) => [item, "deny" as const])),
          }
        }
        function finnyUserAlgoDataPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const patterns = finnyUserAlgoPatterns(["*/data/*", "*/data/*/*", "*/data/*/*/*", "*/data/*/*/*/*", "*/data"])
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        function finnyUserAlgoWorkspaceReadPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const patterns = finnyUserAlgoPatterns(["*", "*/*", "*/*/*", "*/*/*/*", "*/*/*/*/*"])
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        function finnyUserAlgoWorkspaceWritePatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const deny = finnyUserAlgoPatterns(["*", "*/*", "*/*/*", "*/*/*/*", "*/*/*/*/*"])
          const allow = finnyUserAlgoPatterns([
            "*/mission.md",
            "*/todo.md",
            "*/edge_analysis.md",
            "*/analysis",
            "*/analysis/*",
            "*/analysis/*/*",
            "*/analysis/*/*/*",
          ])
          return {
            ...Object.fromEntries([...new Set(deny)].map((item) => [item, "deny" as const])),
            ...Object.fromEntries([...new Set(allow)].map((item) => [item, "allow" as const])),
          }
        }
        function finnyUserAlgoSecPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const patterns = finnyUserAlgoPatterns(["*/data/sec/*", "*/data/sec"])
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        function finnyUserAlgoSentimentReadPatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const patterns = finnyUserAlgoPatterns([
            "*/data/sentiment/*",
            "*/data/sentiment/body/*",
            "*/data/sentiment/body",
            "*/data/sentiment",
          ])
          return Object.fromEntries([...new Set(patterns)].map((item) => [item, "allow" as const]))
        }
        function finnyUserAlgoSentimentWritePatterns(): Exclude<PermissionConfig[keyof PermissionConfig], string> {
          const allow = finnyUserAlgoPatterns(["*/data/sentiment/*", "*/data/sentiment"])
          const deny = finnyUserAlgoPatterns([
            "*/data/sentiment/body",
            "*/data/sentiment/body/*",
            "*/data/sentiment/headlines",
            "*/data/sentiment/headlines/*",
          ])
          return {
            ...Object.fromEntries([...new Set(allow)].map((item) => [item, "allow" as const])),
            ...Object.fromEntries([...new Set(deny)].map((item) => [item, "deny" as const])),
          }
        }
        const finnySessionDataReadAccess = Permission.fromConfig({
          read: finnyUserAlgoDataPatterns(),
          external_directory: finnyUserAlgoDataPatterns(),
        })
        const finnySessionWorkspaceAccess = Permission.fromConfig({
          read: finnyUserAlgoWorkspaceReadPatterns(),
          external_directory: finnyUserAlgoWorkspaceReadPatterns(),
          write: finnyUserAlgoWorkspaceWritePatterns(),
          edit: finnyUserAlgoWorkspaceWritePatterns(),
        })
        const finnySessionNewsAccess = Permission.fromConfig({
          read: finnyUserAlgoNewsReadPatterns(),
          write: finnyUserAlgoNewsWritePatterns(),
          edit: finnyUserAlgoNewsWritePatterns(),
          external_directory: finnyUserAlgoNewsReadPatterns(),
        })
        const finnySessionSecAccess = Permission.fromConfig({
          read: finnyUserAlgoSecPatterns(),
          write: finnyUserAlgoSecPatterns(),
          edit: finnyUserAlgoSecPatterns(),
          external_directory: finnyUserAlgoSecPatterns(),
        })
        const finnySessionSentimentAccess = Permission.fromConfig({
          read: finnyUserAlgoSentimentReadPatterns(),
          write: finnyUserAlgoSentimentWritePatterns(),
          edit: finnyUserAlgoSentimentWritePatterns(),
          external_directory: finnyUserAlgoSentimentReadPatterns(),
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
        // User/global config may be intentionally broad for coding agents, but
        // the visible Finny strategy controller must never inherit a shell or
        // repo-wide mutation capability. Later workspace access adds back only
        // the narrow durable strategy files it owns.
        const finnyStrategySandbox = Permission.fromConfig({
          bash: "deny",
          shell: "deny",
          apply_patch: "deny",
          write: "deny",
          edit: "deny",
        })
        function fundSpecialistAgent(name: FundSpecialistAgent, description: string): Info {
          return {
            name,
            description,
            options: {},
            prompt: PROMPT_FINNY_FUND_SPECIALIST,
            model: { ...FUND_RUNTIME_MODEL },
            permission: Permission.merge(
              defaults,
              user,
              finnyToolBundle(fundSpecialistTools),
              finnyFileSystemSandbox,
              finnySecretReadDeny,
            ),
            mode: "subagent",
            native: true,
            hidden: true,
          }
        }
        const agents: Record<string, Info> = {
          finny: {
            name: "finny",
            description:
              "Finny strategy workflow. Researches first, then builds, validates, backtests, and walk-forward tests with explicit evidence gates.",
            color: "#f97316",
            options: {},
            prompt: PROMPT_FINNY,
            permission: Permission.merge(
              defaults,
              finnyToolBundle(finnyModeTools, ["data_extractor", "news_agent", "sec_agent", "sentiment_agent"]),
              Permission.fromConfig({
                question: "allow",
              }),
              user,
              finnyStrategySandbox,
              finnyTemplateReadAccess,
              finnySessionDataReadAccess,
              finnySessionWorkspaceAccess,
              finnySecretReadDeny,
              finnyPaperApprovalPrompt,
              finnyWorkspaceEditPrompt,
            ),
            mode: "primary",
            native: true,
          },
          build: {
            name: "build",
            description:
              "Build compatibility mode. Consumes an approved ResearchBrief when Research was used, then builds, validates, and backtests.",
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
              finnyPaperApprovalPrompt,
            ),
            mode: "primary",
            native: true,
            hidden: true,
          },
          research: {
            name: "research",
            description:
              "Research compatibility mode. Produces a versioned ResearchBrief; Build requires explicit user approval before execution.",
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
            hidden: true,
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
            hidden: true,
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
          fund_manager: {
            name: FUND_MANAGER_AGENT,
            description:
              "Prompt-gated fund controller. Delegates advisory analysis and emits typed, non-executable action proposals for an external policy gateway.",
            color: "#0f766e",
            options: {},
            model: { ...FUND_RUNTIME_MODEL },
            prompt: PROMPT_FINNY_FUND_MANAGER,
            permission: Permission.merge(
              defaults,
              user,
              finnyToolBundle(fundManagerTools, [...FUND_SPECIALIST_AGENTS]),
              finnyFileSystemSandbox,
              finnySecretReadDeny,
            ),
            mode: "primary",
            native: true,
            hidden: false,
          },
          fund_strategy_researcher: fundSpecialistAgent(
            "fund_strategy_researcher",
            "Researches strategy hypotheses and evidence for the Fund Manager; it cannot create, approve, deploy, or execute a strategy.",
          ),
          fund_regime_analyst: fundSpecialistAgent(
            "fund_regime_analyst",
            "Advises the Fund Manager about regime transitions using only the event context and immutable evidence references supplied to its session.",
          ),
          fund_fill_auditor: fundSpecialistAgent(
            "fund_fill_auditor",
            "Advises whether a reported fill aligns with strategy intent, market evidence, and the supplied portfolio snapshot.",
          ),
          fund_risk_analyst: fundSpecialistAgent(
            "fund_risk_analyst",
            "Advises on portfolio and position risk from immutable snapshots without changing limits or execution state.",
          ),
          fund_code_change_agent: fundSpecialistAgent(
            "fund_code_change_agent",
            "Advises whether strategy logic merits a separately reviewed change; it cannot edit, deploy, or execute code.",
          ),
          fund_independent_validator: fundSpecialistAgent(
            "fund_independent_validator",
            "Independently checks another specialist's evidence and recommendation; it cannot approve or execute the recommendation.",
          ),
          fund_deployment_adviser: fundSpecialistAgent(
            "fund_deployment_adviser",
            "Advises on deployment readiness and rollback evidence; it cannot approve, deploy, or access infrastructure credentials.",
          ),
          fund_risk_sentinel: fundSpecialistAgent(
            "fund_risk_sentinel",
            "Provides an independent fail-closed risk challenge for proposed fund actions; it cannot change limits, approve, or execute.",
          ),
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
              "Collects historical market data and returns concise coverage and regime analysis for strategy research. " +
              "It does not create strategies or run backtests.",
            color: "#06b6d4",
            options: {},
            prompt: PROMPT_FINNY_DATA_EXTRACTOR,
            permission: Permission.merge(
              defaults,
              finnyFileSystemSandbox,
              finnyToolBundle(["bash", "read", "websearch", "webfetch", "finny_dataset_evidence_finalize"]),
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
              'Compatibility alias for news_agent. Prefer task(subagent_type="news_agent") for current news/context work.',
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
              "aggregate-only artifacts directly under the active algorithm data/sentiment/ folder, and returns a " +
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
          const fundConfigIssue = fundAgentConfigError({
            agent: key,
            configuredName: value.name,
            disabled: value.disable,
            model: value.model,
            temperature: value.temperature,
            topP: value.top_p,
            options: value.options,
          })
          if (fundConfigIssue) throw new Error(fundConfigIssue)
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

        // Fund runtime roles remain fixed-model and capability
        // constrained even when user/global configuration is broad. This
        // prompt and visibility are pinned to the reviewed built-in policy.
        const fundManager = agents[FUND_MANAGER_AGENT]
        if (fundManager) {
          fundManager.name = FUND_MANAGER_AGENT
          fundManager.model = { ...FUND_RUNTIME_MODEL }
          fundManager.variant = undefined
          fundManager.options = {}
          fundManager.temperature = undefined
          fundManager.topP = undefined
          fundManager.steps = undefined
          fundManager.mode = "primary"
          fundManager.native = true
          fundManager.hidden = false
          fundManager.prompt = PROMPT_FINNY_FUND_MANAGER
          fundManager.permission = Permission.merge(
            fundManager.permission,
            finnyToolBundle(fundManagerTools, [...FUND_SPECIALIST_AGENTS]),
            finnyFileSystemSandbox,
            finnySecretReadDeny,
          )
        }
        for (const name of FUND_SPECIALIST_AGENTS) {
          const specialist = agents[name]
          if (!specialist) continue
          specialist.name = name
          specialist.model = { ...FUND_RUNTIME_MODEL }
          specialist.variant = undefined
          specialist.options = {}
          specialist.temperature = undefined
          specialist.topP = undefined
          specialist.steps = undefined
          specialist.mode = "subagent"
          specialist.native = true
          specialist.hidden = true
          specialist.prompt = PROMPT_FINNY_FUND_SPECIALIST
          specialist.permission = Permission.merge(
            specialist.permission,
            finnyToolBundle(fundSpecialistTools),
            finnyFileSystemSandbox,
            finnySecretReadDeny,
          )
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
          return agents[resolveBuiltInAgentAlias(agent)]
        })

        const primaryOrder = new Map([
          ["finny", 0],
          ["build", 1],
          ["research", 2],
          ["chat", 3],
          ["portfolio_builder", 4],
          [FUND_MANAGER_AGENT, 5],
        ])

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "finny"), "desc"],
              [(x) => primaryOrder.get(x.name) ?? 100, "asc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultInfo = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const resolved = resolveBuiltInAgentAlias(c.default_agent)
            const agent = agents[resolved]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true && !["build", "research", "chat"].includes(agent.name))
              throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent
          }
          const visiblePreferred = ["finny", "build", "chat", "research"]
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

        const messages: ModelMessage[] = [
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
        ]
        const params = {
          experimental_telemetry: modelTelemetry({
            enabled: cfg.experimental?.openTelemetry,
            tracer,
            userID: cfg.username,
            messages,
            functionID: "agent.generate",
          }),
          temperature: 0.3,
          messages,
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
