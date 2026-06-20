import fs from "node:fs/promises"
import path from "node:path"
import {
  algoDir,
  ensureAlgoWorkspace,
  MISSION_FILE,
  parseMission,
  serializeMission,
  type MissionFrontmatter,
} from "@finny-ai/core/algo"
import { assetClassForSymbol, parseRequestFacts, type RequestFacts } from "./request-identity"

const ISO_DATE_RE = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g
const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
}
const MONTH_DATE_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),\s*(\d{4})\b/gi

export interface DateWindow {
  start?: string
  end?: string
}

export interface WorkspaceRequestContext {
  requested_symbol?: string
  requested_interval?: string
  requested_asset_class?: string
  requested_algorithm_name?: string
  requested_start?: string
  requested_end?: string
  request_id: string
}

export function extractDateWindow(prompt: string): DateWindow {
  const dates = [
    ...[...prompt.matchAll(ISO_DATE_RE)].map((match) => ({ index: match.index ?? 0, date: match[0] })),
    ...[...prompt.matchAll(MONTH_DATE_RE)].map((match) => {
      const month = MONTHS[match[1]!.toLowerCase().replace(".", "")]
      const day = match[2]!.padStart(2, "0")
      return { index: match.index ?? 0, date: `${match[3]}-${month}-${day}` }
    }),
  ]
    .sort((a, b) => a.index - b.index)
    .map((match) => match.date)
  for (let i = 0; i < dates.length - 1; i++) {
    const start = dates[i]
    const end = dates[i + 1]
    if (start && end && start <= end) return { start, end }
  }
  return {}
}

function isoUtcDate(date: Date) {
  return date.toISOString().slice(0, 10)
}

/** Derive a backtest window from relative duration phrases when explicit dates are absent. */
export function inferBacktestWindow(prompt: string, now = new Date()): DateWindow {
  const explicit = extractDateWindow(prompt)
  if (explicit.start && explicit.end) return explicit

  const lower = prompt.toLowerCase()
  let days: number | undefined
  if (/\b(?:three|3)\s*[- ]?\s*months?\b/.test(lower) || /\b3m\s+backtest\b/.test(lower)) days = 90
  else if (/\b(?:six|6)\s*[- ]?\s*months?\b/.test(lower)) days = 180
  else if (/\b(?:one|1)\s*[- ]?\s*months?\b/.test(lower)) days = 30
  else if (/\b(?:twelve|12)\s*[- ]?\s*months?\b|\b1\s*[- ]?\s*y(?:ear|r)\b/.test(lower)) days = 365
  else {
    const match = /\b(\d{2,3})\s*[- ]?\s*days?\b/.exec(lower)
    if (match) days = Number(match[1])
  }
  if (!days) return explicit

  const end = isoUtcDate(now)
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  startDate.setUTCDate(startDate.getUTCDate() - days)
  return { start: isoUtcDate(startDate), end, ...explicit }
}

export function algorithmNameFromWorkspaceSlug(slug: string): string {
  const trimmed = slug.trim()
  if (!trimmed) return trimmed
  const dot = trimmed.indexOf(".")
  return dot === -1 ? trimmed : trimmed.slice(0, dot)
}

export function workspaceRequestContext(
  sessionID: string,
  prompt: string,
  facts: RequestFacts = parseRequestFacts(prompt),
): WorkspaceRequestContext {
  const window = inferBacktestWindow(prompt)
  return {
    requested_symbol: facts.requested_symbol,
    requested_interval: facts.requested_interval,
    requested_asset_class: facts.requested_asset_class ?? assetClassForSymbol(facts.requested_symbol),
    requested_algorithm_name: facts.requested_algorithm_name,
    requested_start: window.start,
    requested_end: window.end,
    request_id: sessionID,
  }
}

function missionAssetClass(
  assetClass: string | undefined,
): MissionFrontmatter["scope"]["asset_class"] | undefined {
  if (assetClass === "equity") return "equities"
  if (assetClass === "crypto") return "crypto"
  return undefined
}

function missionHorizon(interval: string | undefined): MissionFrontmatter["scope"]["horizon"] {
  if (!interval) return "days"
  if (/^\d+m$/.test(interval) || /^\d+h$/.test(interval)) return "intraday"
  if (/^\d+d$/.test(interval)) return "days"
  return "days"
}

function isPlaceholderMission(mission: ReturnType<typeof parseMission>) {
  const fm = mission.frontmatter
  return (
    fm.hypothesis.toLowerCase().includes("pending") ||
    fm.exit_conditions.toLowerCase().includes("pending") ||
    fm.scope.universe.some((item) => item.toLowerCase() === "pending")
  )
}

function renderContextBody(context: WorkspaceRequestContext) {
  const lines = [
    "## Data Request Context",
    "",
    `- requested_symbol: ${context.requested_symbol ?? "MISSING"}`,
    `- requested_interval: ${context.requested_interval ?? "MISSING"}`,
    `- requested_asset_class: ${context.requested_asset_class ?? "MISSING"}`,
    `- requested_start: ${context.requested_start ?? "MISSING"}`,
    `- requested_end: ${context.requested_end ?? "MISSING"}`,
    `- request_id: ${context.request_id}`,
    "",
    "<!-- Bootstrap context. Replaced when the strategy is saved with a full mission. -->",
    "",
  ]
  return lines.join("\n")
}

async function readExistingRequestContext(dir: string): Promise<Partial<WorkspaceRequestContext>> {
  try {
    const raw = await fs.readFile(path.join(dir, "request.json"), "utf8")
    const parsed = JSON.parse(raw)
    return {
      requested_symbol: typeof parsed.requested_symbol === "string" ? parsed.requested_symbol : undefined,
      requested_interval: typeof parsed.requested_interval === "string" ? parsed.requested_interval : undefined,
      requested_asset_class:
        typeof parsed.requested_asset_class === "string" ? parsed.requested_asset_class : undefined,
      requested_algorithm_name:
        typeof parsed.requested_algorithm_name === "string" ? parsed.requested_algorithm_name : undefined,
      requested_start: typeof parsed.requested_start === "string" ? parsed.requested_start : undefined,
      requested_end: typeof parsed.requested_end === "string" ? parsed.requested_end : undefined,
    }
  } catch {
    return {}
  }
}

async function updatePlaceholderMission(dir: string, context: WorkspaceRequestContext): Promise<boolean> {
  const missionPath = path.join(dir, MISSION_FILE)
  let mission: ReturnType<typeof parseMission>
  try {
    mission = parseMission(await fs.readFile(missionPath, "utf8"))
  } catch {
    return false
  }
  if (!isPlaceholderMission(mission)) return false

  const assetClass = missionAssetClass(context.requested_asset_class)
  if (assetClass) mission.frontmatter.scope.asset_class = assetClass
  if (context.requested_symbol) mission.frontmatter.scope.universe = [context.requested_symbol]
  mission.frontmatter.scope.horizon = missionHorizon(context.requested_interval)

  const label = [context.requested_symbol, context.requested_interval].filter(Boolean).join(" ")
  mission.frontmatter.hypothesis = label
    ? `Pending strategy for ${label}; workspace initialized from request context.`
    : "Pending strategy; workspace initialized from request context."
  mission.frontmatter.exit_conditions = "Pending until the strategy is authored, validated, and backtested."
  mission.body = renderContextBody(context)

  await fs.writeFile(missionPath, serializeMission(mission), "utf8")
  return true
}

export async function syncWorkspaceRequestContext(input: {
  sessionID: string
  slug: string
  prompt: string
  facts?: RequestFacts
}): Promise<WorkspaceRequestContext> {
  const ensured = await ensureAlgoWorkspace(input.slug)
  const dir = ensured.dir
  const next = workspaceRequestContext(input.sessionID, input.prompt, input.facts)
  const existing = await readExistingRequestContext(dir)
  const context = {
    requested_symbol: next.requested_symbol ?? existing.requested_symbol,
    requested_interval: next.requested_interval ?? existing.requested_interval,
    requested_asset_class: next.requested_asset_class ?? existing.requested_asset_class,
    requested_algorithm_name:
      next.requested_algorithm_name ?? existing.requested_algorithm_name ?? algorithmNameFromWorkspaceSlug(input.slug),
    requested_start: next.requested_start ?? existing.requested_start,
    requested_end: next.requested_end ?? existing.requested_end,
    request_id: input.sessionID,
  }

  await fs.writeFile(
    path.join(dir, "request.json"),
    JSON.stringify(
      {
        ...context,
        updated: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )
  await updatePlaceholderMission(dir, context)

  return context
}
