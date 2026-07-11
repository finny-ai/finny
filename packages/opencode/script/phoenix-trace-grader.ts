#!/usr/bin/env bun
// @codescene(disable-all) Phoenix grade CLI is a contract boundary for attributed span validation.
import { z } from "zod"

type FailureClass =
  | "unavailable_tool"
  | "bad_write_path"
  | "missing_manifest"
  | "identity_mismatch"
  | "estimated_metric"
  | "provider_limit_handled"
  | "strict_quality_mismatch"
  | "mission_yaml_failure"
  | "lookahead_validation"
  | "clean"

const SpanRowSchema = z
  .object({
    span_id: z.string().optional(),
    trace_id: z.string().nullish(),
    context: z
      .object({
        span_id: z.string().nullish(),
        trace_id: z.string().nullish(),
      })
      .optional(),
    session_id: z.string().nullish(),
    start_time: z.union([z.string(), z.number()]).nullish(),
    end_time: z.union([z.string(), z.number()]).nullish(),
    name: z.string().optional(),
    status_code: z.string().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    resource: z
      .object({ attributes: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .optional(),
    events: z
      .array(z.object({ name: z.string().optional(), attributes: z.record(z.string(), z.unknown()).optional() }))
      .optional(),
  })
  .transform(({ context, ...span }) => ({
    ...span,
    span_id: span.span_id ?? context?.span_id ?? "",
    trace_id: span.trace_id ?? context?.trace_id ?? "",
    session_id: span.session_id ?? "",
  }))
type SpanRow = z.infer<typeof SpanRowSchema>

const PageSchema = z.object({
  data: z.array(SpanRowSchema).default([]),
  next_cursor: z.string().nullable().optional(),
})

interface SessionGrade {
  session_id: string
  trace_ids: string[]
  classes: FailureClass[]
  critical: FailureClass[]
  span_count: number
  sample: string
}

type FetchResult = {
  spans: SpanRow[]
  paginationComplete: boolean
  pages: number
}

export type CliArgs = {
  endpoint: string
  project: string
  session: string
  runId: string
  commit: string
  since: string
  until: string
  requireComplete: boolean
  jsonOut?: string
  annotate: boolean
  maxPages: number
}

const FAILURE_PATTERNS: Array<{ class: FailureClass; re: RegExp; critical?: boolean }> = [
  {
    class: "unavailable_tool",
    re: /(?:\b(?:glob|write|edit|finny_extract_data)\b[^\n]{0,80}\b(?:unavailable|unknown|not (?:available|found|registered)|blocked|denied|disabled|removed)\b|\b(?:unavailable|unknown|not (?:available|found|registered)|blocked|denied|disabled|removed)\b[^\n]{0,80}\b(?:glob|write|edit|finny_extract_data)\b)/i,
    critical: true,
  },
  {
    class: "bad_write_path",
    re: /(_template\/data|packages\/opencode\/data\/news|outside allowed data roots)/i,
    critical: true,
  },
  { class: "missing_manifest", re: /(missing manifest|incomplete evidence artifacts|header-only)/i, critical: true },
  { class: "identity_mismatch", re: /(context mismatch|identity mismatch|workspace_slug mismatch)/i, critical: true },
  { class: "estimated_metric", re: /(estimated[^\n]{0,40}\b(mean|std dev|CAGR)\b|estimated metric)/i, critical: true },
  { class: "provider_limit_handled", re: /BLOCKED: provider limit/i, critical: false },
  {
    class: "strict_quality_mismatch",
    re: /(Data quality failed|strict data quality|usable_for_parent: no)/i,
    critical: true,
  },
  {
    class: "mission_yaml_failure",
    re: /(missionInvalid|frontmatter is not valid YAML|status: draft|horizon: swing)/i,
    critical: true,
  },
  { class: "lookahead_validation", re: /(LOOKAHEAD_BIAS_FLOW|same-bar lookahead)/i, critical: true },
]

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

function parseArgs(argv: string[]): CliArgs {
  const required = ["--project", "--session", "--run-id", "--commit", "--since", "--until"]
  const missing = required.filter((flag) => !valueAfter(argv, flag))
  if (missing.length) throw new Error(`Missing required arguments: ${missing.join(", ")}`)
  const maxPages = Number(valueAfter(argv, "--max-pages") ?? "1000")
  if (!Number.isInteger(maxPages) || maxPages <= 0) throw new Error("--max-pages must be a positive integer")
  const since = valueAfter(argv, "--since")!
  const until = valueAfter(argv, "--until")!
  if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) || Date.parse(since) > Date.parse(until)) {
    throw new Error("--since and --until must be ordered ISO-8601 timestamps")
  }
  return {
    endpoint: valueAfter(argv, "--endpoint") ?? process.env.PHOENIX_COLLECTOR_ENDPOINT ?? "http://127.0.0.1:6006",
    project: valueAfter(argv, "--project")!,
    session: valueAfter(argv, "--session")!,
    runId: valueAfter(argv, "--run-id")!,
    commit: valueAfter(argv, "--commit")!,
    since,
    until,
    requireComplete: argv.includes("--require-complete"),
    jsonOut: valueAfter(argv, "--json"),
    annotate: argv.includes("--annotate"),
    maxPages,
  }
}

function sessionIdOf(span: SpanRow): string {
  if (span.session_id) return span.session_id
  const attrs = span.attributes ?? {}
  const candidate = attrs["session.id"] ?? attrs["finny.session_id"] ?? attrs["openinference.session.id"]
  return typeof candidate === "string" && candidate ? candidate : "unattributed"
}

function attributionAttributes(span: SpanRow): Record<string, unknown> {
  return { ...(span.resource?.attributes ?? {}), ...(span.attributes ?? {}) }
}

function spanTime(value: string | number | null | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function haystack(span: SpanRow): string {
  return [
    span.name ?? "",
    span.status_code ?? "",
    JSON.stringify(span.attributes ?? {}),
    JSON.stringify(span.events ?? []),
  ].join("\n")
}

function classifyText(text: string): FailureClass[] {
  const hits = new Set<FailureClass>()
  for (const pattern of FAILURE_PATTERNS) if (pattern.re.test(text)) hits.add(pattern.class)
  return hits.size > 0 ? [...hits] : ["clean"]
}

function groupBySession(spans: SpanRow[]): Map<string, SpanRow[]> {
  const bySession = new Map<string, SpanRow[]>()
  for (const span of spans) {
    const session = sessionIdOf(span)
    bySession.set(session, [...(bySession.get(session) ?? []), span])
  }
  return bySession
}

function classesForSession(spans: SpanRow[]): FailureClass[] {
  const classes = new Set<FailureClass>()
  for (const span of spans) for (const cls of classifyText(haystack(span))) classes.add(cls)
  if (classes.has("clean") && classes.size > 1) classes.delete("clean")
  return classes.size > 0 ? [...classes] : ["clean"]
}

function criticalClasses(classes: FailureClass[]): FailureClass[] {
  const critical = classes.filter(
    (cls) => FAILURE_PATTERNS.find((pattern) => pattern.class === cls)?.critical !== false,
  )
  return critical.length > 0 ? critical : ["clean"]
}

function gradeSessions(spans: SpanRow[]): SessionGrade[] {
  return [...groupBySession(spans).entries()].map(([session_id, sessionSpans]) => {
    const classes = classesForSession(sessionSpans)
    return {
      session_id,
      trace_ids: [...new Set(sessionSpans.map((span) => span.trace_id).filter(Boolean))],
      classes,
      critical: criticalClasses(classes),
      span_count: sessionSpans.length,
      sample: sessionSpans
        .map((span) => span.name)
        .filter(Boolean)
        .slice(0, 3)
        .join(", "),
    }
  })
}

async function fetchSpans(input: CliArgs): Promise<FetchResult> {
  const base = input.endpoint.replace(/\/+$/, "")
  const spans: SpanRow[] = []
  let cursor: string | undefined
  const cursors = new Set<string>()
  for (let page = 0; page < input.maxPages; page++) {
    const url = new URL(`${base}/v1/projects/${encodeURIComponent(input.project)}/spans`)
    url.searchParams.set("limit", "200")
    url.searchParams.set("start_time", input.since)
    url.searchParams.set("end_time", input.until)
    if (cursor) url.searchParams.set("cursor", cursor)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Phoenix spans request failed (${response.status}): ${await response.text()}`)
    const body = PageSchema.parse(await response.json())
    spans.push(...body.data)
    cursor = body.next_cursor ?? undefined
    if (!cursor) return { spans, paginationComplete: true, pages: page + 1 }
    if (cursors.has(cursor)) return { spans, paginationComplete: false, pages: page + 1 }
    cursors.add(cursor)
  }
  return { spans, paginationComplete: !cursor, pages: input.maxPages }
}

function printTable(grades: SessionGrade[]) {
  console.log(["session", "spans", "classes", "critical", "sample"].join("\t"))
  for (const row of grades.sort((a, b) => a.session_id.localeCompare(b.session_id))) {
    console.log(
      [row.session_id, String(row.span_count), row.classes.join("|"), row.critical.join("|"), row.sample].join("\t"),
    )
  }
}

async function maybeAnnotate(endpoint: string, grades: SessionGrade[]) {
  const base = endpoint.replace(/\/+$/, "")
  for (const grade of grades) {
    if (grade.critical.length === 1 && grade.critical[0] === "clean") continue
    for (const traceId of grade.trace_ids) {
      await fetch(`${base}/v1/traces/${traceId}/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: grade.critical.join(","),
          score: 0,
          explanation: `phoenix-trace-grader: ${grade.classes.join(", ")}`,
        }),
      }).catch(() => undefined)
    }
  }
}

function validateGrade(input: { args: CliArgs; fetched: FetchResult; grades: SessionGrade[] }) {
  const target = input.grades.find((grade) => grade.session_id === input.args.session)
  const unattributed = input.grades.find((grade) => grade.session_id === "unattributed")?.span_count ?? 0
  const completionSpans = input.fetched.spans.filter(
    (span) =>
      span.name === "finny.run.completed" &&
      (attributionAttributes(span)["finny.run_id"] === input.args.runId ||
        attributionAttributes(span)["run.id"] === input.args.runId),
  )
  const completionSpanFound = completionSpans.length === 1
  const agentSpanCount = input.fetched.spans.filter((span) => span.name?.startsWith("finny.agent.")).length
  const toolSpanCount = input.fetched.spans.filter((span) => span.name?.startsWith("finny.tool.")).length
  const reasons: string[] = []
  const since = Date.parse(input.args.since)
  const until = Date.parse(input.args.until)
  const runMismatches = input.fetched.spans.filter((span) => {
    const attrs = attributionAttributes(span)
    return attrs["finny.run_id"] !== input.args.runId && attrs["run.id"] !== input.args.runId
  }).length
  const projectMismatches = input.fetched.spans.filter(
    (span) => attributionAttributes(span)["openinference.project.name"] !== input.args.project,
  ).length
  const commitMismatches = input.fetched.spans.filter(
    (span) => attributionAttributes(span)["git.commit"] !== input.args.commit,
  ).length
  const sessionMismatches = input.fetched.spans.filter((span) => {
    const current = sessionIdOf(span)
    if (current === input.args.session) return false
    const attrs = attributionAttributes(span)
    return (
      attrs["finny.main_session_id"] !== input.args.session ||
      attrs["finny.child_session_id"] !== current ||
      typeof attrs["finny.parent_session_id"] !== "string" ||
      attrs["finny.parent_session_id"] === ""
    )
  }).length
  const mainSessionMismatches = input.fetched.spans.filter(
    (span) => attributionAttributes(span)["finny.main_session_id"] !== input.args.session,
  ).length
  const timeMismatches = input.fetched.spans.filter((span) => {
    const started = spanTime(span.start_time)
    const ended = spanTime(span.end_time) ?? started
    return started === undefined || ended === undefined || started < since || ended > until
  }).length
  if (!input.fetched.paginationComplete) reasons.push("pagination incomplete")
  if (!target || target.span_count === 0) reasons.push("target session has zero spans")
  if (input.fetched.spans.some((span) => !span.trace_id)) reasons.push("one or more spans have null trace IDs")
  if (unattributed > 0) reasons.push(`${unattributed} spans are unattributed`)
  if (runMismatches > 0) reasons.push(`${runMismatches} spans have missing or mismatched run attribution`)
  if (projectMismatches > 0) reasons.push(`${projectMismatches} spans have missing or mismatched project attribution`)
  if (commitMismatches > 0) reasons.push(`${commitMismatches} spans have missing or mismatched commit attribution`)
  if (sessionMismatches > 0) reasons.push(`${sessionMismatches} spans have mismatched direct session attribution`)
  if (mainSessionMismatches > 0) reasons.push(`${mainSessionMismatches} spans have missing or mismatched main-session attribution`)
  if (timeMismatches > 0) reasons.push(`${timeMismatches} spans fall outside or omit the requested time bounds`)
  if (input.args.requireComplete && completionSpans.length === 0) reasons.push("terminal finny.run.completed span is missing")
  if (input.args.requireComplete && completionSpans.length > 1) reasons.push("multiple terminal finny.run.completed spans were found")
  if (input.args.requireComplete && agentSpanCount === 0) reasons.push("attributed agent spans are missing")
  if (input.args.requireComplete && toolSpanCount === 0) reasons.push("attributed tool spans are missing")
  const criticalSessions = input.grades.filter(
    (grade) => !(grade.critical.length === 1 && grade.critical[0] === "clean"),
  )
  if (criticalSessions.length > 0) {
    reasons.push(
      `critical classes: ${criticalSessions.map((grade) => `${grade.session_id}=${grade.critical.join(",")}`).join("; ")}`,
    )
  }
  return {
    valid: reasons.length === 0,
    reasons,
    completionSpanFound,
    completionSpanCount: completionSpans.length,
    agentSpanCount,
    toolSpanCount,
    unattributedSpanCount: unattributed,
    spanCount: input.fetched.spans.length,
    runMismatchCount: runMismatches,
    projectMismatchCount: projectMismatches,
    commitMismatchCount: commitMismatches,
    sessionMismatchCount: sessionMismatches,
    mainSessionMismatchCount: mainSessionMismatches,
    timeMismatchCount: timeMismatches,
    criticalSessionCount: criticalSessions.length,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const fetched = await fetchSpans(args)
  const grades = gradeSessions(fetched.spans)
  const validation = validateGrade({ args, fetched, grades })
  printTable(grades)
  console.log(`\npages=${fetched.pages} pagination_complete=${fetched.paginationComplete} valid=${validation.valid}`)
  for (const reason of validation.reasons) console.error(`CRITICAL: ${reason}`)
  const report = {
    endpoint: args.endpoint,
    project: args.project,
    runId: args.runId,
    commit: args.commit,
    session: args.session,
    fetched,
    grades,
    validation,
  }
  if (args.jsonOut) await Bun.write(args.jsonOut, JSON.stringify(report, null, 2))
  if (args.annotate) await maybeAnnotate(args.endpoint, grades)
  if (!validation.valid) process.exitCode = 5
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(String(error))
    process.exit(5)
  })
}

export {
  classifyText,
  fetchSpans,
  gradeSessions,
  parseArgs,
  sessionIdOf,
  validateGrade,
  attributionAttributes,
  type FailureClass,
  type FetchResult,
  type SessionGrade,
  type SpanRow,
}
