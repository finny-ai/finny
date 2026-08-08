import path from "node:path"
import z from "zod"
import { Effect } from "effect"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import { requestSpecContext, type WorkspaceRequestContext } from "@/agent/finny-workspace-context"
import { readRequestSpecForSession } from "@/agent/request-spec"
import {
  finalizeDatasetEvidenceFile,
  type FinalizeDatasetEvidenceInput,
} from "@/data/dataset-evidence-finalizer"
import { Tool } from "./tool"

const parameters = z.object({
  csvPath: z
    .string()
    .min(1)
    .describe("CSV path relative to the active workspace data directory, for example crypto/BTC_1d.csv."),
  canonicalSymbol: z
    .string()
    .optional()
    .describe("Required only when the bound request contains multiple symbols; must belong to that universe."),
  providerId: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._-]+$/)
    .describe("Provider identity, for example alpaca, binance, polygon, yfinance, oracle, or an internal feed ID."),
  providerFeed: z.string().min(1).describe("Provider feed identity, for example public-klines, sip, or yahoo-chart."),
  providerVenue: z.string().min(1).describe("Venue identity, for example BINANCE, NYSE, or CONSOLIDATED."),
  providerSymbol: z.string().min(1).describe("Exact provider-side symbol used for the fetch."),
  priceBasis: z.enum(["raw", "adjusted", "unknown"]),
  splitTreatment: z.string().min(1),
  dividendTreatment: z.string().min(1),
  corporateActionStatus: z.enum(["resolved", "unresolved", "not_applicable"]),
  analysisSummaryPath: z.string().optional(),
  analysisRegime: z.string().optional(),
  analysisHypotheses: z.array(z.string()).max(3).optional(),
})

type DatasetEvidenceFinalizeMetadata = {
  csvPath?: string
  manifestPath?: string
  evidenceId?: string
  qualification?: string
  coverage?: string
  usableForParent?: "yes" | "no"
  missingRanges?: Array<{ start: string; end: string; count: number }>
}

function toolInput(params: z.infer<typeof parameters>, request: WorkspaceRequestContext, workspaceSlug: string) {
  return {
    dataRoot: path.join(algoDir(workspaceSlug), "data"),
    csvPath: params.csvPath,
    request,
    workspaceSlug,
    canonicalSymbol: params.canonicalSymbol,
    provider: {
      id: params.providerId,
      feed: params.providerFeed,
      venue: params.providerVenue,
      providerSymbol: params.providerSymbol,
    },
    priceBasis: {
      basis: params.priceBasis,
      split_treatment: params.splitTreatment,
      dividend_treatment: params.dividendTreatment,
      corporate_action_status: params.corporateActionStatus,
      events: [],
    },
    analysisSummaryPath: params.analysisSummaryPath,
    analysisRegime: params.analysisRegime,
    analysisHypotheses: params.analysisHypotheses,
  } satisfies FinalizeDatasetEvidenceInput
}

export { finalizeDatasetEvidenceFile } from "@/data/dataset-evidence-finalizer"

export const DatasetEvidenceFinalizeTool = Tool.define<
  typeof parameters,
  DatasetEvidenceFinalizeMetadata,
  never,
  "finny_dataset_evidence_finalize"
>(
  "finny_dataset_evidence_finalize",
  Effect.succeed({
    description:
      "Validate and publish the Data Agent's current canonical OHLCV CSV. Runtime request identity, coverage, " +
      "quality, hashes, and artifact paths are computed server-side. The agent may call this again after updating " +
      "the same dataset to repair coverage.",
    parameters,
    execute: (params, ctx) =>
      Effect.promise(async () => {
        try {
          const workspaceSlug = await getSessionWorkspace(ctx.sessionID).catch(() => null)
          if (!workspaceSlug) throw new Error("no active workspace is bound to the Data Agent session")
          const spec = await readRequestSpecForSession({ sessionID: ctx.sessionID })
          if (!spec) throw new Error("no bound RequestSpec was found")
          const result = await finalizeDatasetEvidenceFile(toolInput(params, requestSpecContext(spec), workspaceSlug))
          return {
            title: "Dataset evidence finalized",
            output: result.digest,
            metadata: {
              csvPath: result.csvPath,
              manifestPath: result.manifestPath,
              evidenceId: result.manifest.evidence_id,
              qualification: result.manifest.qualification.status,
              coverage: result.manifest.coverage,
              usableForParent: result.manifest.usable_for_parent,
              missingRanges: result.manifest.timestamps.missing_ranges,
            },
          }
        } catch (error) {
          return {
            title: "Dataset evidence finalization blocked",
            output: `BLOCKED: dataset evidence finalization failed: ${error instanceof Error ? error.message : String(error)}`,
            metadata: {},
          }
        }
      }),
  }),
)
