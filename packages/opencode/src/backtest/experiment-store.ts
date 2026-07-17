import fs from "node:fs/promises"
import path from "node:path"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import { ExperimentContractError, type ExperimentSpec, type TrialEvent } from "./experiment-types"

export interface ExperimentLocation {
  experimentId: string
}

export interface HoldoutAccessInput {
  spec: ExperimentSpec
  event: TrialEvent
  reason: string
}

export function experimentRootDir() {
  return path.join(path.dirname(finnyArtifactPath("algorithms")), "experiments")
}

function experimentDir({ experimentId }: ExperimentLocation) {
  if (!/^[a-zA-Z0-9._-]{8,120}$/.test(experimentId)) {
    throw new ExperimentContractError("invalid experimentId path segment")
  }
  return path.join(experimentRootDir(), experimentId)
}

function ledgerPath(location: ExperimentLocation) {
  return path.join(experimentDir(location), "trial-ledger.jsonl")
}

export async function readSpec(location: ExperimentLocation): Promise<ExperimentSpec | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(experimentDir(location), "spec.json"), "utf8"))
  } catch {
    return undefined
  }
}

export async function writeSpec(spec: ExperimentSpec) {
  const location = { experimentId: spec.experimentId }
  await fs.mkdir(experimentDir(location), { recursive: true })
  await fs.writeFile(path.join(experimentDir(location), "spec.json"), JSON.stringify(spec, null, 2), {
    flag: "wx",
  })
}

export async function readTrialEvents(location: ExperimentLocation): Promise<TrialEvent[]> {
  try {
    const raw = await fs.readFile(ledgerPath(location), "utf8")
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TrialEvent)
  } catch {
    return []
  }
}

export async function appendEvent(event: TrialEvent) {
  const location = { experimentId: event.experimentId }
  await fs.mkdir(experimentDir(location), { recursive: true })
  await fs.appendFile(ledgerPath(location), `${JSON.stringify(event)}\n`, "utf8")
}

function holdoutPath(location: ExperimentLocation) {
  return path.join(experimentDir(location), "holdout-access.json")
}

export async function holdoutAlreadyOpened(location: ExperimentLocation): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(holdoutPath(location), "utf8"))
    return typeof parsed?.openedAt === "string"
  } catch {
    return false
  }
}

export async function recordHoldoutAccess({ spec, event, reason }: HoldoutAccessInput) {
  const audit = {
    schemaVersion: 1,
    experimentId: spec.experimentId,
    specVersion: spec.version,
    trialId: event.trialId,
    openedAt: event.timestamp,
    approved: true,
    reason,
  }
  try {
    await fs.writeFile(holdoutPath({ experimentId: spec.experimentId }), JSON.stringify(audit, null, 2), { flag: "wx" })
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    throw new ExperimentContractError("the sealed holdout has already been opened for this experiment")
  }
}
