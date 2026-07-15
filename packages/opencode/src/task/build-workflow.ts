import { createHash } from "node:crypto"
import { parseRequestFacts } from "@/agent/request-identity"
import { extractDateWindow } from "@/agent/finny-workspace-context"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer } from "effect"
import z from "zod"

export const Phase = {
  identity: "identity",
  evidence: "evidence",
  design: "design",
  implementation: "implementation",
  validation: "validation",
  save: "save",
  backtest: "backtest",
  report: "report",
} as const

export type Phase = (typeof Phase)[keyof typeof Phase]

export const Terminal = {
  blocked: "blocked",
  failed: "failed",
  interrupted: "interrupted",
  completed: "completed",
} as const

export type Terminal = (typeof Terminal)[keyof typeof Terminal]

// sentiment_agent is discretionary in build prompts and must not terminalize the
// mandatory evidence phase or cancel sibling workers when it fails/blocks alone.
const mandatoryEvidenceRoles = new Set(["data_extractor", "news_agent", "researcher", "sec_agent"])

const toolPhases: Readonly<Record<string, Phase>> = {
  finny_algorithm_scaffold: Phase.implementation,
  write: Phase.implementation,
  edit: Phase.implementation,
  apply_patch: Phase.implementation,
  finny_algorithm_validate: Phase.validation,
  finny_algorithm_save: Phase.save,
  finny_backtest: Phase.backtest,
  finny_portfolio_backtest: Phase.backtest,
}

export function isBuildAgent(agent: string) {
  return agent === "build" || agent === "finny"
}

export function isMandatoryEvidenceRole(role: string) {
  return mandatoryEvidenceRoles.has(role)
}

function providers(prompt: string) {
  return [...prompt.toLowerCase().matchAll(/\b(alpaca|binance|ibkr|polygon|yahoo|sec|edgar|perplexity)\b/g)]
    .map((match) => match[1])
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort()
}

export function taskFingerprint(input: {
  role: string
  prompt: string
  providerID: string
  recoveryRevision?: string
}) {
  const facts = parseRequestFacts(input.prompt)
  const window = extractDateWindow(input.prompt)
  const identity = {
    role: input.role,
    provider: input.providerID.trim().toLowerCase(),
    symbols: [...(facts.requested_symbols ?? [])].map((symbol) => symbol.toUpperCase()).sort(),
    symbol: facts.requested_symbol?.toUpperCase(),
    interval: facts.requested_interval,
    assetClass: facts.requested_asset_class,
    algorithm: facts.requested_algorithm_name?.trim().toLowerCase(),
    start: window.start,
    end: window.end,
    evidenceProviders: providers(input.prompt),
    recoveryRevision: input.recoveryRevision,
  }
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex")
}

export function terminalBlock(input: { fingerprint: string; reason?: string; status: "blocked" | "failed" }) {
  const reason = input.reason?.trim() || `mandatory evidence task previously ended ${input.status}`
  return [
    `BLOCKED: mandatory Build evidence is terminal for fingerprint ${input.fingerprint.slice(0, 12)}.`,
    `Evidence: ${reason.slice(0, 1_000)}`,
    "Recovery options: change the request identity or evidence window; select a different provider; or resolve the provider/runtime blocker and start a new user turn.",
    "Do not schedule this fingerprint again in the current Build run. Return one concise blocked answer to the user.",
  ].join("\n")
}

export const Event = {
  PhaseTransition: BusEvent.define(
    "build.workflow.phase",
    z.object({
      sessionID: z.string(),
      workflowRunID: z.string(),
      from: z.enum(Phase).optional(),
      to: z.enum(Phase),
      fingerprint: z.string().optional(),
      role: z.string().optional(),
      tool: z.string().optional(),
    }),
  ),
  Terminal: BusEvent.define(
    "build.workflow.terminal",
    z.object({
      sessionID: z.string(),
      workflowRunID: z.string(),
      state: z.enum(Terminal),
      phase: z.enum(Phase),
      fingerprint: z.string().optional(),
      reason: z.string().optional(),
    }),
  ),
}

type TaskStatus = "running" | "blocked" | "completed" | "failed" | "cancelled"

type TaskRecord = {
  fingerprint: string
  role: string
  status: TaskStatus
  output?: string
  sessionID?: string
}

export type Run = {
  sessionID: string
  workflowRunID: string
  phase: Phase
  terminal?: Terminal
  tasks: Map<string, TaskRecord>
}

type EvidenceProjectionInput = {
  sessionID: string
  workflowRunID: string
  role: string
  prompt: string
  providerID: string
  recoveryRevision?: string
}

export function projectEvidenceStartState(run: Run | undefined, input: EvidenceProjectionInput) {
  const fingerprint = taskFingerprint(input)
  const projection: Run =
    run ?? {
      sessionID: input.sessionID,
      workflowRunID: input.workflowRunID,
      phase: Phase.identity,
      tasks: new Map(),
    }
  const from = projection.phase
  projection.terminal = undefined
  projection.phase = Phase.evidence
  projection.tasks.set(fingerprint, { fingerprint, role: input.role, status: "running" })
  return { projection, fingerprint, from }
}

export interface Interface {
  /** Projection-only notification. Durable WorkflowRun owns authorization. */
  readonly projectEvidenceStart: (input: {
    sessionID: string
    workflowRunID: string
    role: string
    prompt: string
    providerID: string
    recoveryRevision?: string
  }) => Effect.Effect<{ fingerprint: string }>
  readonly attachSession: (input: {
    sessionID: string
    workflowRunID: string
    fingerprint: string
    taskSessionID: string
  }) => Effect.Effect<void>
  readonly finishEvidence: (input: {
    sessionID: string
    workflowRunID: string
    fingerprint: string
    status: TaskStatus
    output?: string
  }) => Effect.Effect<void>
  readonly finishRun: (input: {
    sessionID: string
    workflowRunID: string
    state: Terminal
    reason?: string
  }) => Effect.Effect<void>
  readonly recordToolCompletion: (input: {
    sessionID: string
    workflowRunID: string
    toolID: string
  }) => Effect.Effect<void>
  readonly get: (input: { sessionID: string; workflowRunID: string }) => Effect.Effect<Run | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BuildWorkflow") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make(
      Effect.fn("BuildWorkflow.state")(function* () {
        return new Map<string, Run>()
      }),
    )

    const key = (input: { sessionID: string; workflowRunID: string }) => `${input.sessionID}:${input.workflowRunID}`

    const get: Interface["get"] = Effect.fn("BuildWorkflow.get")(function* (input) {
      return (yield* InstanceState.get(state)).get(key(input))
    })

    const projectEvidenceStart: Interface["projectEvidenceStart"] = Effect.fn(
      "BuildWorkflow.projectEvidenceStart",
    )(function* (input) {
      const runs = yield* InstanceState.get(state)
      const runKey = key(input)
      const existing = runs.get(runKey)
      const { projection: run, fingerprint, from } = projectEvidenceStartState(existing, input)
      runs.set(runKey, run)
      if (!existing) {
        yield* bus.publish(Event.PhaseTransition, {
          sessionID: input.sessionID,
          workflowRunID: input.workflowRunID,
          to: Phase.identity,
        })
      }

      yield* bus.publish(Event.PhaseTransition, {
        sessionID: input.sessionID,
        workflowRunID: input.workflowRunID,
        from,
        to: Phase.evidence,
        fingerprint,
        role: input.role,
      })
      return { fingerprint }
    })

    const attachSession: Interface["attachSession"] = Effect.fn("BuildWorkflow.attachSession")(function* (input) {
      const run = yield* get(input)
      const task = run?.tasks.get(input.fingerprint)
      if (task) task.sessionID = input.taskSessionID
    })

    const finishEvidence: Interface["finishEvidence"] = Effect.fn("BuildWorkflow.finishEvidence")(function* (input) {
      const run = yield* get(input)
      const task = run?.tasks.get(input.fingerprint)
      if (!run || !task) return
      task.status = input.status
      task.output = input.output
      if (input.status === "completed") {
        if (![...run.tasks.values()].some((record) => record.status === "running")) {
          const from = run.phase
          run.phase = Phase.design
          yield* bus.publish(Event.PhaseTransition, {
            sessionID: input.sessionID,
            workflowRunID: input.workflowRunID,
            from,
            to: Phase.design,
            fingerprint: input.fingerprint,
          })
        }
        return
      }
      if (run.terminal) return

      run.terminal =
        input.status === "blocked"
          ? Terminal.blocked
          : input.status === "cancelled"
            ? Terminal.interrupted
            : Terminal.failed
      yield* bus.publish(Event.Terminal, {
        sessionID: input.sessionID,
        workflowRunID: input.workflowRunID,
        state: run.terminal,
        phase: run.phase,
        fingerprint: input.fingerprint,
        reason: input.output?.slice(0, 1_000),
      })
    })

    const phases = Object.values(Phase)
    const recordToolCompletion: Interface["recordToolCompletion"] = Effect.fn("BuildWorkflow.recordToolCompletion")(
      function* (input) {
        const target = toolPhases[input.toolID]
        const run = yield* get(input)
        if (!target || !run || run.terminal) return
        const currentIndex = phases.indexOf(run.phase)
        const targetIndex = phases.indexOf(target)
        if (targetIndex <= currentIndex) return
        for (const next of phases.slice(currentIndex + 1, targetIndex + 1)) {
          const from = run.phase
          run.phase = next
          yield* bus.publish(Event.PhaseTransition, {
            sessionID: input.sessionID,
            workflowRunID: input.workflowRunID,
            from,
            to: next,
            tool: input.toolID,
          })
        }
      },
    )

    const finishRun: Interface["finishRun"] = Effect.fn("BuildWorkflow.finishRun")(function* (input) {
      const run = yield* get(input)
      if (!run || run.terminal) return
      if (input.state === Terminal.completed && run.phase !== Phase.report) {
        const from = run.phase
        run.phase = Phase.report
        yield* bus.publish(Event.PhaseTransition, {
          sessionID: input.sessionID,
          workflowRunID: input.workflowRunID,
          from,
          to: Phase.report,
        })
      }
      run.terminal = input.state
      yield* bus.publish(Event.Terminal, {
        sessionID: input.sessionID,
        workflowRunID: input.workflowRunID,
        state: input.state,
        phase: run.phase,
        reason: input.reason?.slice(0, 1_000),
      })
    })

    return Service.of({ projectEvidenceStart, attachSession, finishEvidence, finishRun, recordToolCompletion, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.defaultLayer))

export const node = LayerNode.make(layer, [Bus.node])

export * as BuildWorkflow from "./build-workflow"
