import fs from "node:fs/promises"
import path from "node:path"
import type { BacktestRunner } from "./runner"
import { experimentRootDir } from "./experiment-store"
import { withExperimentLock } from "./experiment-lock"
import { qualificationHash, type QualificationPolicyV1 } from "./qualification-policy"
import type { QualificationBlockerV1 } from "./qualification"
import type { ExperimentPlanV1 } from "./experiment-plan"

export type QualificationAttemptPhaseV1 = "preflight" | "exploratory" | "validation" | "confirmatory"

export interface QualificationExecutionIdentityV1 {
  codeHash: string
  configHash: string
}

export interface QualificationAttemptEventV1 {
  schema: "finny.qualification_attempt_event"
  version: 1
  eventId: string
  attemptId: string
  event: "started" | "completed" | "blocked"
  occurredAt: string
  planId: string
  planHash: string
  candidateId: string
  phase: QualificationAttemptPhaseV1
  policyId: string
  policyHash: string
  codeHash: string
  configHash: string
  result?: BacktestRunner.RunResult
  blocker?: QualificationBlockerV1
}

interface AttemptIdentity {
  plan: ExperimentPlanV1
  candidateId: string
  phase: QualificationAttemptPhaseV1
  policy: QualificationPolicyV1
  executionIdentity: QualificationExecutionIdentityV1
}

export type QualificationAttemptClaimV1 =
  | { kind: "execute"; attemptId: string }
  | { kind: "completed"; attemptId: string; result: BacktestRunner.RunResult }
  | { kind: "blocked"; attemptId: string; blocker: QualificationBlockerV1 }

export interface QualificationAttemptLedgerV1 {
  claim(input: AttemptIdentity): Promise<QualificationAttemptClaimV1>
  complete(input: AttemptIdentity & {
    attemptId: string
    result: BacktestRunner.RunResult
    blocker?: QualificationBlockerV1
  }): Promise<void>
  block(input: AttemptIdentity & { blocker: QualificationBlockerV1 }): Promise<QualificationBlockerV1>
}

function safeId(value: string) {
  if (!/^[a-zA-Z0-9._-]{8,120}$/.test(value)) throw new Error("invalid qualification experiment id")
  return value
}

function ledgerFile(planId: string) {
  return path.join(experimentRootDir(), safeId(planId), "qualification-attempt-ledger.jsonl")
}

function attemptId(input: AttemptIdentity, blocker?: QualificationBlockerV1) {
  const hash = qualificationHash({
    planId: input.plan.planId,
    planHash: input.plan.planHash,
    candidateId: input.candidateId,
    phase: input.phase,
    policyId: input.policy.policyId,
    policyHash: input.policy.policyHash,
    ...input.executionIdentity,
    blocker: blocker ? { code: blocker.code, field: blocker.field, message: blocker.message } : undefined,
  })
  return `qattempt-${hash.slice(0, 24)}`
}

function event(
  input: AttemptIdentity,
  id: string,
  kind: QualificationAttemptEventV1["event"],
  terminal: Pick<QualificationAttemptEventV1, "result" | "blocker"> = {},
): QualificationAttemptEventV1 {
  const draft = {
    schema: "finny.qualification_attempt_event" as const,
    version: 1 as const,
    attemptId: id,
    event: kind,
    occurredAt: new Date().toISOString(),
    planId: input.plan.planId,
    planHash: input.plan.planHash,
    candidateId: input.candidateId,
    phase: input.phase,
    policyId: input.policy.policyId,
    policyHash: input.policy.policyHash,
    ...input.executionIdentity,
    ...terminal,
  }
  return { ...draft, eventId: `qevent-${qualificationHash(draft).slice(0, 24)}` }
}

function verifyEvent(item: QualificationAttemptEventV1) {
  const { eventId, ...draft } = item
  if (eventId !== `qevent-${qualificationHash(draft).slice(0, 24)}`) {
    throw new Error(`qualification attempt ledger event ${eventId} failed integrity verification`)
  }
  return item
}

export async function readQualificationAttemptEventsV1(planId: string): Promise<QualificationAttemptEventV1[]> {
  try {
    const bytes = await fs.readFile(ledgerFile(planId), "utf8")
    return bytes.split("\n").filter(Boolean).map((line) => verifyEvent(JSON.parse(line) as QualificationAttemptEventV1))
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function append(item: QualificationAttemptEventV1) {
  const file = ledgerFile(item.planId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(item)}\n`, "utf8")
}

function interruptedBlocker(): QualificationBlockerV1 {
  return {
    schema: "finny.qualification_blocker",
    version: 1,
    code: "attempt_interrupted",
    field: "attemptId",
    message: "a durable phase attempt started without a terminal event",
    nextAllowedTransition: "reconcile the interrupted attempt; do not execute the unchanged phase again",
  }
}

export const DurableQualificationAttemptLedgerV1: QualificationAttemptLedgerV1 = {
  claim: (input) => withExperimentLock(input.plan.planId, async () => {
    const id = attemptId(input)
    const events = (await readQualificationAttemptEventsV1(input.plan.planId)).filter((item) => item.attemptId === id)
    const terminal = events.findLast((item) => item.event !== "started")
    if (terminal?.event === "completed" && terminal.result) return { kind: "completed", attemptId: id, result: terminal.result }
    if (terminal?.event === "blocked" && terminal.blocker) return { kind: "blocked", attemptId: id, blocker: terminal.blocker }
    if (events.some((item) => item.event === "started")) {
      const blocker = interruptedBlocker()
      await append(event(input, id, "blocked", { blocker }))
      return { kind: "blocked", attemptId: id, blocker }
    }
    await append(event(input, id, "started"))
    return { kind: "execute", attemptId: id }
  }),
  complete: (input) => withExperimentLock(input.plan.planId, async () => {
    const events = await readQualificationAttemptEventsV1(input.plan.planId)
    if (events.some((item) => item.attemptId === input.attemptId && item.event !== "started")) return
    await append(event(input, input.attemptId, input.blocker ? "blocked" : "completed", {
      result: input.result,
      blocker: input.blocker,
    }))
  }),
  block: (input) => withExperimentLock(input.plan.planId, async () => {
    const id = attemptId(input, input.blocker)
    const existing = (await readQualificationAttemptEventsV1(input.plan.planId)).find(
      (item) => item.attemptId === id && item.event === "blocked",
    )
    if (existing?.blocker) return existing.blocker
    await append(event(input, id, "blocked", { blocker: input.blocker }))
    return input.blocker
  }),
}
