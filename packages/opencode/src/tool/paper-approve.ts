import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import z from "zod"
import { Effect } from "effect"
import { finnyArtifactPath } from "@finny-ai/core/prefs"
import { Algorithm } from "../algorithm"
import { Tool } from "./tool"

const parameters = z.object({
  algorithmName: z.string().describe("Name of the saved algorithm whose latest recommended run should be approved for paper trading."),
  runId: z.string().optional().describe("Optional immutable run id. Defaults to newest run.json for the algorithm version."),
})

type ApprovalMetadata = {
  approved: boolean
  runId?: string
  runPath?: string
  expected?: string
  actual?: string
}

function sha256Text(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex")
}

function runsDir(algorithm: Algorithm.Info): string {
  const version = Number((algorithm as any).version ?? 0) || 0
  return path.join(
    finnyArtifactPath("algorithms"),
    algorithm.algorithmId,
    `v${String(version).padStart(2, "0")}`,
    "runs",
  )
}

async function existingRunDir(root: string, runId: string): Promise<string | undefined> {
  const candidate = path.join(root, runId)
  try {
    return (await fs.stat(path.join(candidate, "run.json"))).isFile() ? candidate : undefined
  } catch {
    return undefined
  }
}

async function newestRunDir(root: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    let newest: { mtime: number; dir: string } | undefined
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      try {
        const stat = await fs.stat(path.join(dir, "run.json"))
        if (!newest || stat.mtimeMs > newest.mtime) newest = { mtime: stat.mtimeMs, dir }
      } catch {}
    }
    return newest?.dir
  } catch {
    return undefined
  }
}

async function latestRunDir(algorithm: Algorithm.Info, runId?: string): Promise<string | undefined> {
  const root = runsDir(algorithm)
  return runId ? existingRunDir(root, runId) : newestRunDir(root)
}

export const PaperApproveTool = Tool.define<typeof parameters, ApprovalMetadata, never, "finny_paper_approve">(
  "finny_paper_approve",
  Effect.succeed({
    description:
      "Explicitly approve a recommended unified backtest run for paper trading after human review. This is the only tool that can flip run.json eligibilityStatus to paper_eligible.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_paper_approve",
          patterns: ["*"],
          always: [],
          metadata: {},
        })

        const algo = await Algorithm.get(params.algorithmName)
        if (!algo) {
          return {
            title: "Paper approval failed",
            output: `Algorithm "${params.algorithmName}" not found. Use finny_algorithm_list to see available algorithms.`,
            metadata: { approved: false } satisfies ApprovalMetadata,
          }
        }

        const dir = await latestRunDir(algo, params.runId)
        if (!dir) {
          return {
            title: "Paper approval refused",
            output: params.runId ? `Run "${params.runId}" was not found for ${algo.name}.` : `No completed run.json was found for ${algo.name}.`,
            metadata: { approved: false } satisfies ApprovalMetadata,
          }
        }

        const runPath = path.join(dir, "run.json")
        const durabilityPath = path.join(dir, "durability.json")
        const run = JSON.parse(await fs.readFile(runPath, "utf8"))
        if (run.unifiedVerdict !== "recommended_for_paper") {
          return {
            title: "Paper approval refused",
            output: `Run ${run.runId ?? path.basename(dir)} is not recommended_for_paper (unifiedVerdict=${run.unifiedVerdict ?? "missing"}).`,
            metadata: { approved: false, runId: run.runId } satisfies ApprovalMetadata,
          }
        }
        try {
          await fs.access(durabilityPath)
        } catch {
          return {
            title: "Paper approval refused",
            output: `Run ${run.runId ?? path.basename(dir)} has no durability.json review baseline.`,
            metadata: { approved: false, runId: run.runId } satisfies ApprovalMetadata,
          }
        }

        const currentHash = sha256Text(algo.code)
        if (run.strategyHash !== currentHash) {
          return {
            title: "Paper approval refused",
            output: `Run ${run.runId ?? path.basename(dir)} was produced from a different strategy hash. Re-run finny_backtest after the latest edits before approval.`,
            metadata: { approved: false, runId: run.runId, expected: currentHash, actual: run.strategyHash } satisfies ApprovalMetadata,
          }
        }

        const priorEligibility = run.eligibilityStatus ?? "prototype"
        const approved = {
          ...run,
          eligibilityStatus: "paper_eligible",
          approval: {
            approvedAt: new Date().toISOString(),
            approvedVia: "finny_paper_approve",
            priorEligibility,
            verdict: run.unifiedVerdict,
          },
        }
        await fs.writeFile(runPath, JSON.stringify(approved, null, 2))
        const manifestPath = path.join(dir, "manifest.json")
        try {
          const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"))
          manifest.approvals = Array.isArray(manifest.approvals) ? manifest.approvals : []
          manifest.approvals.push(approved.approval)
          await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
        } catch {}

        return {
          title: "Paper approved",
          output: `Run ${approved.runId} is now paper_eligible. Live paper gate will pick it up from ${runPath}.`,
          metadata: { approved: true, runId: approved.runId, runPath } satisfies ApprovalMetadata,
        }
      }),
  }),
)
