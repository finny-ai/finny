import z from "zod"

export const RESEARCH_BRIEF_FILE = "research-brief.json"
export const RESEARCH_BRIEF_SCHEMA_VERSION = 1 as const

const nonEmpty = z.string().trim().min(1)

export const ResearchBriefContentSchema = z.object({
  hypothesis: nonEmpty.optional(),
  economicRationale: nonEmpty.optional(),
  requiredDatasets: z.array(nonEmpty).optional(),
  availabilityConstraints: z.array(nonEmpty).optional(),
  executionAssumptions: z
    .object({
      fees: nonEmpty.optional(),
      slippage: nonEmpty.optional(),
      spreads: nonEmpty.optional(),
      liquidityAndFills: nonEmpty.optional(),
    })
    .optional(),
  temporalLeakageRules: z.array(nonEmpty).optional(),
  inSamplePlan: nonEmpty.optional(),
  outOfSamplePlan: nonEmpty.optional(),
  falsificationCriteria: z.array(nonEmpty).optional(),
  minimumEvidence: z.array(nonEmpty).optional(),
  unresolvedQuestions: z.array(nonEmpty).optional(),
})

const ResearchBriefIdentitySchema = z.object({
  request_id: nonEmpty,
  requested_symbol: nonEmpty.optional(),
  requested_symbols: z.array(nonEmpty).optional(),
  requested_interval: nonEmpty.optional(),
  requested_asset_class: nonEmpty.optional(),
  requested_algorithm_name: nonEmpty.optional(),
})

export const PersistedResearchBriefSchema = ResearchBriefContentSchema.extend({
  schema_version: z.literal(RESEARCH_BRIEF_SCHEMA_VERSION),
  identity: ResearchBriefIdentitySchema,
  transition: z.enum(["draft", "approved", "cancelled"]),
  revision: z.number().int().positive(),
  created_at: nonEmpty,
  updated_at: nonEmpty,
  approved_at: nonEmpty.optional(),
})

export type ResearchBriefContent = z.infer<typeof ResearchBriefContentSchema>
export type ResearchBrief = z.infer<typeof PersistedResearchBriefSchema>
export type ResearchBriefIdentity = ResearchBrief["identity"]
export type ResearchTransition = ResearchBrief["transition"]

export interface ResearchBriefStatus {
  exists: boolean
  buildReady: boolean
  stale: boolean
  missing: string[]
  brief?: ResearchBrief
  reason?: string
}
