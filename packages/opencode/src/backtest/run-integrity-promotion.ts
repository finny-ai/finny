import fs from "node:fs/promises"
import path from "node:path"
import type { Algorithm } from "@/algorithm"
import type { ControllerPaperApproval } from "@/algorithm/build-workflow/paper-approval"
import {
  RUN_APPROVAL_SCHEMA,
  readJson,
  sha256Text,
  strictRunDir,
  versionDir,
  writeJsonExclusive,
  type IntegrityResult,
  type RunApprovalV1,
  type RunIdentityV1,
  type StrictRunV1,
} from "./run-integrity-core"
import { verifyStrictRunDir } from "./run-integrity-verify"

async function readVersionFile(file: string): Promise<string> {
  return fs.readFile(file, "utf8")
}

export async function currentAlgorithmHashes(
  algorithm: Algorithm.Info,
): Promise<Pick<RunIdentityV1, "strategyHash" | "savedConfigHash" | "documentHashes" | "riskContractHash">> {
  const version = versionDir(algorithm)
  return {
    strategyHash: sha256Text(await readVersionFile(path.join(version, "strategy.py"))),
    savedConfigHash: sha256Text(await readVersionFile(path.join(version, "config.json"))),
    documentHashes: {
      mission: sha256Text(await readVersionFile(path.join(version, "mission.md"))),
      preferences: sha256Text(await readVersionFile(path.join(version, "prefs.md"))),
      decisions: sha256Text(await readVersionFile(path.join(version, "decisions.md"))),
      reasoning: sha256Text(await readVersionFile(path.join(version, "reasoning.md"))),
    },
    riskContractHash: sha256Text(await readVersionFile(path.join(version, "risk.json"))),
  }
}

function pushVersionDrift(errors: string[], identity: RunIdentityV1, algorithm: Algorithm.Info, current: Awaited<ReturnType<typeof currentAlgorithmHashes>>) {
  if (identity.algorithmId !== algorithm.algorithmId) errors.push("run belongs to another algorithm")
  if (identity.algorithmVersion !== algorithm.version) errors.push("run belongs to another algorithm version")
  if (identity.strategyHash !== current.strategyHash) errors.push("strategy changed after the run")
  if (identity.savedConfigHash !== current.savedConfigHash) errors.push("saved config changed after the run")
  if (identity.riskContractHash !== current.riskContractHash) errors.push("risk contract changed after the run")
  for (const key of Object.keys(current.documentHashes) as Array<keyof typeof current.documentHashes>) {
    if (identity.documentHashes[key] !== current.documentHashes[key]) errors.push(`${key} document changed after the run`)
  }
}

export async function verifyRunForAlgorithm(algorithm: Algorithm.Info, runId: string): Promise<IntegrityResult> {
  const result = await verifyStrictRunDir(strictRunDir(algorithm, runId))
  if (!result.run) return result
  const current = await currentAlgorithmHashes(algorithm)
  pushVersionDrift(result.errors, result.run.identity, algorithm, current)
  result.ok = result.errors.length === 0
  return result
}

export async function readApproval(dir: string, decision: RunApprovalV1["decision"]): Promise<RunApprovalV1 | null> {
  const file = decision === "paper_eligible" ? "approval.json" : "live-eligibility.json"
  try {
    return await readJson<RunApprovalV1>({ file: path.join(dir, file) })
  } catch {
    return null
  }
}

function sameRun(authority: ControllerPaperApproval, run: StrictRunV1): boolean {
  if (authority.runId !== run.runId) return false
  return authority.identityHash === run.identityHash
}

function sameChallenge(approval: RunApprovalV1, authority: ControllerPaperApproval): boolean {
  if (approval.workflowId !== authority.workflowId) return false
  if (approval.challengeId !== authority.challengeId) return false
  if (approval.scopeHash !== authority.scopeHash) return false
  return true
}

function sameOptionalIds(approval: RunApprovalV1, authority: ControllerPaperApproval): boolean {
  if (approval.sourceMessageId !== authority.sourceMessageId) return false
  return approval.questionRequestId === authority.questionRequestId
}

function paperAuthorityMatches(approval: RunApprovalV1, authority: ControllerPaperApproval, run: StrictRunV1): boolean {
  if (!sameRun(authority, run)) return false
  if (approval.approvedVia !== "algorithm_build_workflow") return false
  if (!sameChallenge(approval, authority)) return false
  return sameOptionalIds(approval, authority)
}

export function matchingApproval(
  run: StrictRunV1,
  approval: RunApprovalV1 | null,
  decision: RunApprovalV1["decision"],
  authority?: ControllerPaperApproval,
): boolean {
  if (!approval) return false
  if (approval.schema !== RUN_APPROVAL_SCHEMA || approval.version !== 1) return false
  if (approval.runId !== run.runId || approval.identityHash !== run.identityHash) return false
  if (approval.decision !== decision) return false
  if (decision !== "paper_eligible") return true
  if (!authority) return false
  return paperAuthorityMatches(approval, authority, run)
}

function buildPaperApproval(run: StrictRunV1, authority: ControllerPaperApproval, approvedAt?: string): RunApprovalV1 {
  return {
    schema: RUN_APPROVAL_SCHEMA,
    version: 1,
    runId: run.runId,
    identityHash: run.identityHash,
    decision: "paper_eligible",
    approvedAt: approvedAt ?? new Date(authority.grantedAt).toISOString(),
    approvedVia: "algorithm_build_workflow",
    workflowId: authority.workflowId,
    challengeId: authority.challengeId,
    scopeHash: authority.scopeHash,
    ...(authority.sourceMessageId ? { sourceMessageId: authority.sourceMessageId } : {}),
    ...(authority.questionRequestId ? { questionRequestId: authority.questionRequestId } : {}),
  }
}

async function existingPaperApprovalOrThrow(
  dir: string,
  run: StrictRunV1,
  authority: ControllerPaperApproval,
): Promise<RunApprovalV1> {
  const existing = await readApproval(dir, "paper_eligible")
  if (!matchingApproval(run, existing, "paper_eligible", authority)) {
    throw new Error("approval.json already exists but does not match this immutable run and workflow approval")
  }
  return existing!
}

export async function writePaperApproval(input: {
  dir: string
  run: StrictRunV1
  authority: ControllerPaperApproval
  approvedAt?: string
}): Promise<{ approval: RunApprovalV1; created: boolean }> {
  const file = path.join(input.dir, "approval.json")
  const approval = buildPaperApproval(input.run, input.authority, input.approvedAt)
  try {
    await writeJsonExclusive({ file: file, value: approval })
    return { approval, created: true }
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error
    return { approval: await existingPaperApprovalOrThrow(input.dir, input.run, input.authority), created: false }
  }
}

export async function verifyPromotion(input: {
  algorithm: Algorithm.Info
  runId: string
  /** Normalized market requested for the live/paper worker. */
  symbol?: string
  mode: "paper" | "testnet" | "live"
  controllerApproval?: ControllerPaperApproval
}): Promise<{ ok: boolean; status: string | null; errors: string[]; run?: StrictRunV1 }> {
  const integrity = await verifyRunForAlgorithm(input.algorithm, input.runId)
  if (!integrity.ok || !integrity.run) return { ok: false, status: null, errors: integrity.errors, run: integrity.run }
  if (
    integrity.run.identity.datasetEvidence?.version !== 2 ||
    integrity.run.identity.datasetEvidence.qualification !== "strict_qualified" ||
    !integrity.run.identity.datasetEvidence.id
  ) {
    return {
      ok: false,
      status: null,
      errors: ["promotion requires immutable strict_qualified DatasetEvidenceV2"],
      run: integrity.run,
    }
  }
  if (input.symbol) {
    const config = await readJson<{ symbol?: unknown }>({
      file: path.join(strictRunDir(input.algorithm, input.runId), "effective_config.json"),
    })
    const approvedSymbol = typeof config.symbol === "string" ? config.symbol.trim().toUpperCase() : ""
    const requestedSymbol = input.symbol.trim().toUpperCase()
    if (!approvedSymbol || approvedSymbol !== requestedSymbol) {
      return {
        ok: false,
        status: null,
        errors: [
          `approved run market mismatch (approved=${approvedSymbol || "missing"}, requested=${requestedSymbol}); run a separate backtest and approval for this market`,
        ],
        run: integrity.run,
      }
    }
  }
  if (input.mode === "live") {
    return {
      ok: false,
      status: null,
      errors: ["live_eligible has no approved forward-validation producer; new live starts fail closed"],
      run: integrity.run,
    }
  }
  const decision = "paper_eligible" as const
  const approval = await readApproval(strictRunDir(input.algorithm, input.runId), decision)
  if (!matchingApproval(integrity.run, approval, decision, input.controllerApproval)) {
    return { ok: false, status: null, errors: [`matching ${decision} workflow approval record is missing`], run: integrity.run }
  }
  if (integrity.run.recommendation.verdict !== "recommended_for_paper") {
    return { ok: false, status: null, errors: ["run is not recommended_for_paper"], run: integrity.run }
  }
  return { ok: true, status: decision, errors: [], run: integrity.run }
}
