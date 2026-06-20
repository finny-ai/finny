#!/usr/bin/env bun
/**
 * Read-only Phoenix trace grader for Finny data-agent / Build failure classes.
 *
 * Usage:
 *   bun packages/opencode/script/phoenix-trace-grader.ts
 *   bun packages/opencode/script/phoenix-trace-grader.ts --json report.json
 *   PHOENIX_COLLECTOR_ENDPOINT=http://127.0.0.1:6006 bun packages/opencode/script/phoenix-trace-grader.ts
 *
 * Optional annotation mode (mutates Phoenix; explicit opt-in):
 *   bun packages/opencode/script/phoenix-trace-grader.ts --annotate
 */

const DEFAULT_ENDPOINT = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? "http://127.0.0.1:6006"
const PROJECT = process.env.PHOENIX_PROJECT ?? "default"

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

interface SpanRow {
  span_id: string
  trace_id: string
  session_id: string
  name?: string
  status_code?: string
  attributes?: Record<string, unknown>
  events?: Array<{ name?: string; attributes?: Record<string, unknown> }>
}

interface SessionGrade {
  session_id: string
  trace_ids: string[]
  classes: FailureClass[]
  critical: FailureClass[]
  span_count: number
  sample: string
}

const FAILURE_PATTERNS: Array<{ class: FailureClass; re: RegExp; critical?: boolean }> = [
  { class: "unavailable_tool", re: /\b(glob|write|edit|finny_extract_data)\b/i, critical: true },
  { class: "bad_write_path", re: /(_template\/data|packages\/opencode\/data\/news|outside allowed data roots)/i, critical: true },
  { class: "missing_manifest", re: /(missing manifest|incomplete evidence artifacts|header-only)/i, critical: true },
  { class: "identity_mismatch", re: /(context mismatch|identity mismatch|workspace_slug mismatch)/i, critical: true },
  { class: "estimated_metric", re: /(\bmean\b|\bstd dev\b|CAGR|estimated metric)/i, critical: true },
  { class: "provider_limit_handled", re: /BLOCKED: provider limit/i, critical: false },
  { class: "strict_quality_mismatch", re: /(Data quality failed|strict data quality|usable_for_parent: no)/i, critical: true },
  { class: "mission_yaml_failure", re: /(missionInvalid|frontmatter is not valid YAML|status: draft|horizon: swing)/i, critical: true },
  { class: "lookahead_validation", re: /(LOOKAHEAD_BIAS_FLOW|same-bar lookahead)/i, critical: true },
]

function parseArgs(argv: string[]) {
  const jsonOut = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : undefined
  const annotate = argv.includes("--annotate")
  return { jsonOut, annotate }
}

function sessionIdOf(span: SpanRow): string {
  const attrs = span.attributes ?? {}
  return String(
    attrs["session.id"] ??
      attrs["finny.session_id"] ??
      attrs["openinference.session.id"] ??
      span.trace_id,
  )
}

function haystack(span: SpanRow): string {
  const attrs = JSON.stringify(span.attributes ?? {})
  const events = JSON.stringify(span.events ?? [])
  return [span.name ?? "", span.status_code ?? "", attrs, events].join("\n")
}

function classifyText(text: string): FailureClass[] {
  const hits = new Set<FailureClass>()
  for (const pattern of FAILURE_PATTERNS) {
    if (pattern.re.test(text)) hits.add(pattern.class)
  }
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
  for (const span of spans) {
    for (const cls of classifyText(haystack(span))) classes.add(cls)
  }
  if (classes.has("clean") && classes.size > 1) classes.delete("clean")
  return classes.size > 0 ? [...classes] : ["clean"]
}

function criticalClasses(classes: FailureClass[]): FailureClass[] {
  const critical = classes.filter((cls) => FAILURE_PATTERNS.find((p) => p.class === cls)?.critical !== false)
  return critical.length > 0 ? critical : ["clean"]
}

function sampleSpanNames(spans: SpanRow[]): string {
  return spans
    .map((span) => span.name)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ")
}

async function fetchSpans(endpoint: string): Promise<SpanRow[]> {
  const base = endpoint.replace(/\/+$/, "")
  const rows: SpanRow[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${base}/v1/projects/${PROJECT}/spans`)
    url.searchParams.set("limit", "200")
    if (cursor) url.searchParams.set("cursor", cursor)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Phoenix spans request failed (${res.status}): ${await res.text()}`)
    const body = (await res.json()) as { data?: SpanRow[]; next_cursor?: string | null }
    rows.push(...(body.data ?? []))
    cursor = body.next_cursor ?? undefined
    if (!cursor || (body.data?.length ?? 0) === 0) break
  }
  return rows
}

function gradeSessions(spans: SpanRow[]): SessionGrade[] {
  return [...groupBySession(spans).entries()].map(([session_id, sessionSpans]) => {
    const classes = classesForSession(sessionSpans)
    return {
      session_id,
      trace_ids: [...new Set(sessionSpans.map((s) => s.trace_id))],
      classes,
      critical: criticalClasses(classes),
      span_count: sessionSpans.length,
      sample: sampleSpanNames(sessionSpans),
    }
  })
}

function printTable(grades: SessionGrade[]) {
  const header = ["session", "spans", "classes", "critical", "sample"].join("\t")
  console.log(header)
  for (const row of grades.sort((a, b) => a.session_id.localeCompare(b.session_id))) {
    console.log(
      [row.session_id, String(row.span_count), row.classes.join("|"), row.critical.join("|"), row.sample].join("\t"),
    )
  }
  const criticalCount = grades.filter((g) => !g.critical.includes("clean") || g.critical.length > 1).length
  console.log("")
  console.log(`sessions=${grades.length} critical=${criticalCount}`)
}

async function maybeAnnotate(endpoint: string, grades: SessionGrade[]) {
  const base = endpoint.replace(/\/+$/, "")
  for (const grade of grades) {
    if (grade.critical.includes("clean") && grade.critical.length === 1) continue
    for (const traceId of grade.trace_ids) {
      await fetch(`${base}/v1/traces/${traceId}/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: grade.critical.join(","),
          score: grade.critical.includes("clean") ? 1 : 0,
          explanation: `phoenix-trace-grader: ${grade.classes.join(", ")}`,
        }),
      }).catch(() => undefined)
    }
  }
}

async function main() {
  const { jsonOut, annotate } = parseArgs(process.argv.slice(2))
  const spans = await fetchSpans(DEFAULT_ENDPOINT)
  const grades = gradeSessions(spans)
  printTable(grades)
  if (jsonOut) {
    await Bun.write(jsonOut, JSON.stringify({ endpoint: DEFAULT_ENDPOINT, project: PROJECT, grades }, null, 2))
  }
  if (annotate) await maybeAnnotate(DEFAULT_ENDPOINT, grades)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err))
    process.exit(1)
  })
}

export { classifyText, gradeSessions, type FailureClass, type SessionGrade }
