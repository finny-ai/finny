import fs from "node:fs/promises"
import path from "node:path"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import {
  compileExperimentPlanV1,
  compileExperimentPlanV2,
  verifyExperimentPlanV1,
  verifyExperimentPlanV2,
  type CompileExperimentPlanInput,
  type CompileExperimentPlanV2Input,
  type ExperimentPlanV1,
  type ExperimentPlanV2,
} from "./experiment-plan"
import {
  confirmatoryPolicyErrors,
  makeHoldoutOpenEventV1,
  type HoldoutOpenEventV1,
  type QualificationPolicyV1,
} from "./qualification-policy"

function root() {
  return path.join(path.dirname(finnyArtifactPath("algorithms")), "experiment-plans")
}

function safeId(input: { value: string; field: string }) {
  if (!/^[a-zA-Z0-9._-]{8,120}$/.test(input.value)) throw new Error(`${input.field} is not a safe identifier`)
  return input.value
}

function planDir(input: { planId: string }) {
  return path.join(root(), safeId({ value: input.planId, field: "experimentPlanId" }))
}

async function writeImmutableJson(input: { file: string; value: unknown; mismatch: string }) {
  const bytes = JSON.stringify(input.value, null, 2)
  try {
    await fs.writeFile(input.file, bytes, { flag: "wx" })
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    if ((await fs.readFile(input.file, "utf8")) !== bytes) throw new Error(input.mismatch, { cause: error })
  }
}

export async function saveExperimentPlanV1(plan: ExperimentPlanV1, policy: QualificationPolicyV1) {
  const errors = verifyExperimentPlanV1(plan)
  if (errors.length) throw new Error(errors.join("; "))
  const policyErrors = confirmatoryPolicyErrors(policy)
  if (policyErrors.length) throw new Error(policyErrors.join("; "))
  if (plan.qualificationPolicyId !== policy.policyId || plan.qualificationPolicyHash !== policy.policyHash) {
    throw new Error("experiment plan qualification policy binding mismatch")
  }
  const dir = planDir({ planId: plan.planId })
  await fs.mkdir(dir, { recursive: true })
  await writeImmutableJson({ file: path.join(dir, "plan.json"), value: plan, mismatch: "experiment plan id already exists with different bytes" })
  await writeImmutableJson({ file: path.join(dir, "policy.json"), value: policy, mismatch: "experiment plan policy already exists with different bytes" })
  return plan
}

export async function compileAndSaveExperimentPlanV1(input: CompileExperimentPlanInput) {
  return saveExperimentPlanV1(compileExperimentPlanV1(input), input.qualificationPolicy)
}

export async function loadExperimentPlanPolicyV1(planId: string): Promise<QualificationPolicyV1> {
  const plan = await loadExperimentPlanV1(planId)
  const policy = JSON.parse(await fs.readFile(path.join(planDir({ planId }), "policy.json"), "utf8")) as QualificationPolicyV1
  const errors = confirmatoryPolicyErrors(policy)
  if (errors.length) throw new Error(errors.join("; "))
  if (plan.qualificationPolicyId !== policy.policyId || plan.qualificationPolicyHash !== policy.policyHash) {
    throw new Error("stored qualification policy does not match experiment plan")
  }
  return policy
}

export async function loadExperimentPlanV1(planId: string): Promise<ExperimentPlanV1> {
  const plan = JSON.parse(await fs.readFile(path.join(planDir({ planId }), "plan.json"), "utf8")) as ExperimentPlanV1
  const errors = verifyExperimentPlanV1(plan)
  if (errors.length || plan.planId !== planId) throw new Error(errors[0] ?? "stored experiment plan id mismatch")
  return plan
}

export async function loadExperimentPlanV2(planId: string): Promise<ExperimentPlanV2> {
  const plan = JSON.parse(await fs.readFile(path.join(planDir({ planId }), "plan.json"), "utf8")) as ExperimentPlanV2
  const errors = verifyExperimentPlanV2(plan)
  if (errors.length || plan.planId !== planId) throw new Error(errors[0] ?? "stored experiment plan id mismatch")
  return plan
}

export async function saveExperimentPlanV2(plan: ExperimentPlanV2, policy: QualificationPolicyV1) {
  const errors = verifyExperimentPlanV2(plan)
  if (errors.length) throw new Error(errors.join("; "))
  const policyErrors = confirmatoryPolicyErrors(policy)
  if (policyErrors.length) throw new Error(policyErrors.join("; "))
  if (plan.qualificationPolicyId !== policy.policyId || plan.qualificationPolicyHash !== policy.policyHash) {
    throw new Error("experiment plan qualification policy binding mismatch")
  }
  const dir = planDir({ planId: plan.planId })
  await fs.mkdir(dir, { recursive: true })
  await writeImmutableJson({
    file: path.join(dir, "plan.json"),
    value: plan,
    mismatch: "experiment plan id already exists with different bytes",
  })
  await writeImmutableJson({
    file: path.join(dir, "policy.json"),
    value: policy,
    mismatch: "experiment plan policy already exists with different bytes",
  })
  return plan
}

export async function compileAndSaveExperimentPlanV2(input: CompileExperimentPlanV2Input) {
  const plan = compileExperimentPlanV2(input)
  await saveExperimentPlanV2(plan, input.qualificationPolicy)
  return plan
}

function holdoutFile(input: { planId: string }) {
  return path.join(planDir(input), "holdout-open.json")
}

export async function readHoldoutOpenEventsV1(planId: string): Promise<HoldoutOpenEventV1[]> {
  try {
    return [JSON.parse(await fs.readFile(holdoutFile({ planId }), "utf8")) as HoldoutOpenEventV1]
  } catch {
    return []
  }
}

export async function recordHoldoutOpenEventV1(input: {
  plan: ExperimentPlanV1
  approvalHash: string
  openedAt?: string
}): Promise<HoldoutOpenEventV1> {
  return recordHoldoutOpenEvent({ planId: input.plan.planId, planHash: input.plan.planHash, ...input })
}

export async function recordHoldoutOpenEventForPlanV2(input: {
  plan: ExperimentPlanV2
  approvalHash: string
  openedAt?: string
}): Promise<HoldoutOpenEventV1> {
  return recordHoldoutOpenEvent({ planId: input.plan.planId, planHash: input.plan.planHash, ...input })
}

async function recordHoldoutOpenEvent(input: {
  planId: string
  planHash: string
  approvalHash: string
  openedAt?: string
}): Promise<HoldoutOpenEventV1> {
  if (!/^[a-f0-9]{64}$/i.test(input.approvalHash)) throw new Error("holdout approval hash must be SHA-256")
  const event = makeHoldoutOpenEventV1({
    planId: input.planId,
    planHash: input.planHash,
    approvalHash: input.approvalHash,
    openedAt: input.openedAt ?? new Date().toISOString(),
  })
  await fs.writeFile(holdoutFile({ planId: input.planId }), JSON.stringify(event, null, 2), { flag: "wx" })
  return event
}
