import type { RequestFacts } from "./request-identity"
import type {
  ResearchBrief,
  ResearchBriefContent,
  ResearchBriefIdentity,
  ResearchTransition,
} from "./research-brief-schema"

type ContentKey = keyof ResearchBriefContent
type ExecutionKey = keyof NonNullable<ResearchBriefContent["executionAssumptions"]>

const REQUIRED_TEXT: ReadonlyArray<readonly [ContentKey, string]> = [
  ["hypothesis", "hypothesis"],
  ["economicRationale", "economicRationale"],
  ["inSamplePlan", "inSamplePlan"],
  ["outOfSamplePlan", "outOfSamplePlan"],
]

const REQUIRED_LISTS: ReadonlyArray<readonly [ContentKey, string]> = [
  ["requiredDatasets", "requiredDatasets"],
  ["availabilityConstraints", "availabilityConstraints"],
  ["temporalLeakageRules", "temporalLeakageRules"],
  ["falsificationCriteria", "falsificationCriteria"],
  ["minimumEvidence", "minimumEvidence"],
]

const REQUIRED_EXECUTION: ReadonlyArray<readonly [ExecutionKey, string]> = [
  ["fees", "executionAssumptions.fees"],
  ["slippage", "executionAssumptions.slippage"],
  ["spreads", "executionAssumptions.spreads"],
  ["liquidityAndFills", "executionAssumptions.liquidityAndFills"],
]

const IDENTITY_FACTS: ReadonlyArray<
  readonly [keyof RequestFacts, Exclude<keyof ResearchBriefIdentity, "request_id" | "requested_symbols">]
> = [
  ["requested_symbol", "requested_symbol"],
  ["requested_interval", "requested_interval"],
  ["requested_asset_class", "requested_asset_class"],
  ["requested_algorithm_name", "requested_algorithm_name"],
]

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === "string")
  return strings.length ? strings : undefined
}

function listsEqual(left?: string[], right?: string[]): boolean {
  if (!left || !right) return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function researchBriefIdentity(context: Record<string, unknown>): ResearchBriefIdentity {
  return {
    request_id: optionalString(context.request_id) ?? "unknown",
    requested_symbol: optionalString(context.requested_symbol),
    requested_symbols: optionalStringList(context.requested_symbols),
    requested_interval: optionalString(context.requested_interval),
    requested_asset_class: optionalString(context.requested_asset_class),
    requested_algorithm_name: optionalString(context.requested_algorithm_name),
  }
}

export function sameResearchIdentity(left: ResearchBriefIdentity, right: ResearchBriefIdentity): boolean {
  return (
    left.request_id === right.request_id &&
    left.requested_symbol === right.requested_symbol &&
    listsEqual(left.requested_symbols, right.requested_symbols) &&
    left.requested_interval === right.requested_interval &&
    left.requested_asset_class === right.requested_asset_class &&
    left.requested_algorithm_name === right.requested_algorithm_name
  )
}

export function researchBriefMatchesFacts(brief: ResearchBrief, facts: RequestFacts): boolean {
  const scalarFactsMatch = IDENTITY_FACTS.every(([factKey, identityKey]) => {
    const expected = facts[factKey]
    return !expected || expected === brief.identity[identityKey]
  })
  const symbolsMatch =
    !facts.requested_symbols?.length || listsEqual(facts.requested_symbols, brief.identity.requested_symbols)
  return scalarFactsMatch && symbolsMatch
}

function missingRequiredText(
  content: ResearchBriefContent,
  requirements: ReadonlyArray<readonly [ContentKey, string]>,
): string[] {
  return requirements.flatMap(([key, label]) => {
    const value = content[key]
    return typeof value === "string" && value.trim().length > 0 ? [] : [label]
  })
}

function missingRequiredLists(
  content: ResearchBriefContent,
  requirements: ReadonlyArray<readonly [ContentKey, string]>,
): string[] {
  // Empty arrays are truthy but not an approval boundary — require non-empty content.
  return requirements.flatMap(([key, label]) => {
    const value = content[key]
    return Array.isArray(value) && value.length > 0 ? [] : [label]
  })
}

export function missingResearchBriefFields(content: ResearchBriefContent): string[] {
  const missing = [
    ...missingRequiredText(content, REQUIRED_TEXT),
    ...missingRequiredLists(content, REQUIRED_LISTS),
    ...REQUIRED_EXECUTION.flatMap(([key, label]) => (content.executionAssumptions?.[key] ? [] : [label])),
  ]
  if (content.unresolvedQuestions === undefined) missing.push("unresolvedQuestions")
  else if (content.unresolvedQuestions.length) missing.push("unresolvedQuestions must be empty")
  return missing
}

function scalarIdentityConflict(left?: string, right?: string): boolean {
  if (!left || !right) return false
  return left !== right
}

function symbolListConflict(left?: string[], right?: string[]): boolean {
  if (!left?.length || !right?.length) return false
  return !listsEqual(left, right)
}

/** True when request identity states a fact that contradicts the brief (not merely omits it). */
export function requestIdentityConflictsBrief(
  brief: ResearchBrief,
  identity: ResearchBriefIdentity | undefined,
): boolean {
  if (!identity) return false
  if (scalarIdentityConflict(identity.requested_symbol, brief.identity.requested_symbol)) return true
  if (scalarIdentityConflict(identity.requested_interval, brief.identity.requested_interval)) return true
  if (scalarIdentityConflict(identity.requested_asset_class, brief.identity.requested_asset_class)) return true
  if (scalarIdentityConflict(identity.requested_algorithm_name, brief.identity.requested_algorithm_name)) {
    return true
  }
  return symbolListConflict(identity.requested_symbols, brief.identity.requested_symbols)
}

export function researchBriefBlockReason(input: {
  stale: boolean
  transition: ResearchTransition
  missing: string[]
}): string | undefined {
  if (input.stale) return "research brief identity does not match request.json"
  if (input.transition === "cancelled") return "research was cancelled"
  if (input.transition !== "approved") return "research brief is not user-approved"
  if (input.missing.length) return `research brief is incomplete: ${input.missing.join(", ")}`
  return undefined
}

export function renderResearchBriefHandoff(brief: ResearchBrief): string {
  return [
    "<research-brief>",
    "This approved, versioned ResearchBrief is the authoritative Build handoff. Preserve its request identity, assumptions, temporal-leakage rules, validation plan, falsification criteria, and minimum evidence exactly. Do not reconstruct or override it from prose history.",
    JSON.stringify(brief, null, 2),
    "</research-brief>",
  ].join("\n")
}
