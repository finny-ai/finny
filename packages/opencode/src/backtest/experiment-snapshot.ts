import fs from "node:fs/promises"
import path from "node:path"
import { ExperimentContractError } from "./experiment-types"
import { experimentRootDir } from "./experiment-store"

export interface DataSnapshotInput {
  experimentId: string
  expectedDataSnapshot: string
  actualDataHash?: string
}

function snapshotPath(input: DataSnapshotInput) {
  return path.join(experimentRootDir(), input.experimentId, "data-snapshot.json")
}

function assertExpectedDataSnapshot(input: DataSnapshotInput) {
  if (input.expectedDataSnapshot !== "engine-data-hash-bound-at-completion" && input.expectedDataSnapshot !== input.actualDataHash) {
    throw new ExperimentContractError("backtest data hash differs from the frozen experiment dataSnapshot")
  }
}

async function existingDataSnapshot(input: DataSnapshotInput) {
  return JSON.parse(await fs.readFile(snapshotPath(input), "utf8"))
}

async function writeDataSnapshot(input: Required<DataSnapshotInput>) {
  const snapshot = { schemaVersion: 1, experimentId: input.experimentId, dataHash: input.actualDataHash }
  try {
    await fs.writeFile(snapshotPath(input), JSON.stringify(snapshot, null, 2), { flag: "wx" })
    return snapshot
  } catch (error: unknown) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    return existingDataSnapshot(input)
  }
}

export async function assertDataSnapshot(input: DataSnapshotInput) {
  if (!input.actualDataHash) return
  assertExpectedDataSnapshot(input)
  const snapshot = await writeDataSnapshot({ ...input, actualDataHash: input.actualDataHash })
  if (snapshot?.dataHash !== input.actualDataHash) {
    throw new ExperimentContractError("backtest data hash differs from the first observed experiment data snapshot")
  }
}
