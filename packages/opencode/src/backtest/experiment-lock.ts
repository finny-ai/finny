import fs from "node:fs/promises"
import path from "node:path"
import { ExperimentContractError } from "./experiment-types"
import { experimentRootDir } from "./experiment-store"

interface LockInput {
  experimentId: string
}

function lockPath(input: LockInput) {
  return path.join(experimentRootDir(), input.experimentId, "trial-ledger.lock")
}

async function acquireLock(input: LockInput) {
  await fs.mkdir(path.dirname(lockPath(input)), { recursive: true })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fs.mkdir(lockPath(input))
      return
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new ExperimentContractError(`timed out waiting for experiment ledger lock: ${input.experimentId}`)
}

export async function withExperimentLock<T>(experimentId: string, action: () => Promise<T>): Promise<T> {
  const input = { experimentId }
  await acquireLock(input)
  try {
    return await action()
  } finally {
    await fs.rm(lockPath(input), { recursive: true, force: true })
  }
}
