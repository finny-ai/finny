import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Effect } from "effect"
import { finnyHomeArtifacts } from "@finny-ai/core/prefs"
import { Algorithm } from "../algorithm"
import { resolveAlgorithmFolder } from "../algorithm/folder"
import { generateFinalQuantReview } from "../backtest/final-review-packet"
import { Tool } from "./tool"

const parameters = z.object({
  algorithmName: z.string().min(1).describe("Saved algorithm name."),
  experimentId: z.string().regex(/^[a-zA-Z0-9._-]{8,120}$/).optional().describe("For generation only: exact Review experiment ID returned by finny_backtest. Omit when opening an existing packet."),
  conclusion: z.enum(["recommended_for_paper", "research_complete", "concept_exhausted", "optimization_exhausted", "blocked", "user_stopped"]).optional(),
  reason: z.string().min(1).max(1000).optional().describe("For generation only: evidence-backed terminal reason and recommended next action."),
})

type ReviewPacketMetadata = {
  created: boolean
  reviewPath?: string
  reviewDir?: string
  experimentId?: string
  conclusion?: z.infer<typeof parameters>["conclusion"]
  runCount?: number
  versionCount?: number
}

async function reviewCandidates(root: string): Promise<string[]> {
  const candidates = [path.join(root, "review.html")]
  try {
    const entries = await fs.readdir(path.join(root, "reviews"), { withFileTypes: true })
    candidates.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, "reviews", entry.name, "review.html")))
  } catch {}
  const existing = await Promise.all(candidates.map(async (file) => {
    try {
      const stat = await fs.stat(file)
      return stat.isFile() ? { file, modified: stat.mtimeMs } : undefined
    } catch {
      return undefined
    }
  }))
  return existing
    .filter((item): item is { file: string; modified: number } => item !== undefined)
    .sort((a, b) => b.modified - a.modified || b.file.localeCompare(a.file))
    .map((item) => item.file)
}

export async function findLatestReviewPacketInRoots(roots: string[]): Promise<string | undefined> {
  const candidates = (await Promise.all(roots.map(reviewCandidates))).flat()
  if (!candidates.length) return undefined
  const ranked = await Promise.all(candidates.map(async (file) => ({ file, modified: (await fs.stat(file)).mtimeMs })))
  return ranked.sort((a, b) => b.modified - a.modified || b.file.localeCompare(a.file))[0]?.file
}

export async function findLatestReviewPacket(algorithm: Algorithm.Info): Promise<string | undefined> {
  const artifacts = finnyHomeArtifacts()
  const resolved = await resolveAlgorithmFolder({
    algorithmId: algorithm.algorithmId,
    name: algorithm.name,
    algosRoot: artifacts.algos,
    algorithmsRoot: artifacts.algorithms,
  })
  const roots = [resolved.found ? resolved.path : undefined, path.join(artifacts.algorithms, algorithm.algorithmId)]
    .filter((root, index, all): root is string => Boolean(root) && all.indexOf(root) === index)
  return findLatestReviewPacketInRoots(roots)
}

async function openReviewPacket(reviewPath: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return "Automatic opening is available on macOS only."
  try {
    const child = Bun.spawn(["open", reviewPath], { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
    const exitCode = await child.exited
    if (exitCode === 0) return undefined
    return `macOS open exited with code ${exitCode}`
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export const ReviewPacketTool = Tool.define<typeof parameters, ReviewPacketMetadata, never, "finny_review_packet">(
  "finny_review_packet",
  Effect.succeed({
    description: "Open an existing saved quant review packet by passing algorithmName only; this lookup is read-only and must not trigger workspace preparation, evidence subagents, or a backtest. To generate a new final packet after iteration, also pass experimentId, conclusion, and reason; generation requires positive total return, stitched walk-forward OOS return, and alpha versus buy-and-hold.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        const permissionPattern = params.experimentId ?? params.algorithmName
        await ctx.ask({ permission: "finny_review_packet", patterns: [permissionPattern], always: [permissionPattern], metadata: {} })
        const algorithm = await Algorithm.get(params.algorithmName)
        if (!algorithm) return { title: "Review packet failed", output: `Algorithm "${params.algorithmName}" not found.`, metadata: { created: false } satisfies ReviewPacketMetadata }
        if (!params.experimentId) {
          const reviewPath = await findLatestReviewPacket(algorithm)
          if (!reviewPath) {
            return {
              title: "Review packet not found",
              output: `No saved review packet exists for "${params.algorithmName}". This lookup did not run a backtest or launch evidence agents.`,
              metadata: { created: false },
            }
          }
          const openError = await openReviewPacket(reviewPath)
          return {
            title: openError ? "Review packet found" : "Review packet opened",
            output: `${openError ? `Could not open automatically (${openError}).\n` : ""}Open quant review packet: ${reviewPath}`,
            metadata: { created: false, reviewPath, reviewDir: path.dirname(reviewPath) },
          }
        }
        if (!params.conclusion || !params.reason) {
          return {
            title: "Review packet generation needs terminal evidence",
            output: "Generating a new packet requires experimentId, conclusion, and reason. To open an existing packet, pass algorithmName only.",
            metadata: { created: false, experimentId: params.experimentId },
          }
        }
        try {
          const result = await generateFinalQuantReview({ algorithm, experimentId: params.experimentId, conclusion: params.conclusion, conclusionReason: params.reason })
          return {
            title: "Quant review packet ready",
            output: `Final quant review packet created for ${result.data.runs.length} participating run(s) across ${result.data.versions.length} version(s).\nOpen quant review packet: ${result.reviewPath}\nPaper approval remains explicit and separate.`,
            metadata: { created: true, reviewPath: result.reviewPath, reviewDir: result.reviewDir, experimentId: params.experimentId, conclusion: params.conclusion, runCount: result.data.runs.length, versionCount: result.data.versions.length } satisfies ReviewPacketMetadata,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const ineligible = message.includes("final review requires") || message.includes("final review is produced only")
          return { title: ineligible ? "Review packet not produced" : "Review packet failed", output: `${ineligible ? "Final quant review was not produced" : "Could not generate the final quant review packet"}: ${message}`, metadata: { created: false, experimentId: params.experimentId } satisfies ReviewPacketMetadata }
        }
      }),
  }),
)
