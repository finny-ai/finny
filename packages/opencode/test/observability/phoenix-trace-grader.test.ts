import { afterEach, describe, expect, test } from "bun:test"
import {
  classifyText,
  fetchSpans,
  gradeSessions,
  parseArgs,
  sessionIdOf,
  validateGrade,
} from "../../script/phoenix-trace-grader"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function args(extra: string[] = []) {
  return parseArgs([
    "--project",
    "run-1",
    "--session",
    "ses-main",
    "--run-id",
    "run-1",
    "--commit",
    "commit-1",
    "--since",
    "2026-07-09T00:00:00Z",
    "--until",
    "2026-07-09T01:00:00Z",
    "--require-complete",
    ...extra,
  ])
}

describe("Phoenix trace attribution", () => {
  test("uses the direct session_id before attribute fallbacks", () => {
    expect(
      sessionIdOf({
        span_id: "span",
        trace_id: "trace",
        session_id: "ses-direct",
        attributes: { "session.id": "ses-fallback" },
      }),
    ).toBe("ses-direct")
  })

  test("does not classify ordinary metric means as estimated metrics", () => {
    expect(classifyText("OOS Sharpe mean: -1.2")).toEqual(["clean"])
    expect(classifyText("estimated mean close 420.5")).toContain("estimated_metric")
  })

  test("does not mistake successful tool names for unavailable-tool failures", () => {
    expect(classifyText(JSON.stringify({ "tool.name": "write", status: "completed" }))).toEqual(["clean"])
    expect(classifyText("tool call glob blocked by unavailable tool policy")).toContain("unavailable_tool")
    expect(classifyText("finny_extract_data is not registered")).toContain("unavailable_tool")
  })

  test("paginates beyond the old 4,000-span cap", async () => {
    let page = 0
    globalThis.fetch = (async () => {
      page++
      const data = Array.from({ length: 200 }, (_, index) => ({
        span_id: `span-${page}-${index}`,
        trace_id: `trace-${page}`,
        session_id: "ses-main",
        start_time: "2026-07-09T00:10:00Z",
        end_time: "2026-07-09T00:10:01Z",
        name:
          page === 21 && index === 0
            ? "finny.run.completed"
            : page === 1 && index === 0
              ? "finny.agent.run"
              : page === 1 && index === 1
                ? "finny.tool.execute"
                : "session.llm",
        attributes: { "finny.run_id": "run-1", "finny.main_session_id": "ses-main", "git.commit": "commit-1" },
        resource: { attributes: { "openinference.project.name": "run-1" } },
      }))
      return new Response(JSON.stringify({ data, next_cursor: page < 21 ? `page-${page + 1}` : null }), {
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof fetch

    const fetched = await fetchSpans(args())
    expect(fetched.spans).toHaveLength(4_200)
    expect(fetched.pages).toBe(21)
    expect(fetched.paginationComplete).toBe(true)
    const grades = gradeSessions(fetched.spans)
    expect(validateGrade({ args: args(), fetched, grades })).toMatchObject({
      valid: true,
      spanCount: 4_200,
      agentSpanCount: 1,
      toolSpanCount: 1,
    })
  })

  test("queries the whole project window so child and unattributed spans cannot be hidden", async () => {
    let requested: URL | undefined
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requested = new URL(String(input))
      return new Response(
        JSON.stringify({
          data: [
            {
              span_id: "main",
              trace_id: "trace",
              session_id: "ses-main",
              start_time: "2026-07-09T00:10:00Z",
              end_time: "2026-07-09T00:10:01Z",
              name: "finny.run.completed",
              attributes: {
                "finny.run_id": "run-1",
                "finny.main_session_id": "ses-main",
                "git.commit": "commit-1",
              },
              resource: { attributes: { "openinference.project.name": "run-1" } },
            },
            {
              span_id: "unattributed",
              trace_id: "trace",
              start_time: "2026-07-09T00:10:00Z",
              end_time: "2026-07-09T00:10:01Z",
              name: "finny.tool.execute",
              attributes: {},
            },
          ],
          next_cursor: null,
        }),
        { headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const fetched = await fetchSpans(args())
    expect(requested?.searchParams.has("session_id")).toBe(false)
    expect(requested?.searchParams.get("start_time")).toBe("2026-07-09T00:00:00Z")
    expect(requested?.searchParams.get("end_time")).toBe("2026-07-09T01:00:00Z")
    const validation = validateGrade({ args: args(), fetched, grades: gradeSessions(fetched.spans) })
    expect(validation.valid).toBe(false)
    expect(validation.unattributedSpanCount).toBe(1)
  })

  test("missing completion or attribution is invalid", () => {
    const fetched = {
      spans: [{ span_id: "span", trace_id: "", session_id: "", name: "session.llm", attributes: {} }],
      paginationComplete: true,
      pages: 1,
    }
    const validation = validateGrade({ args: args(), fetched, grades: gradeSessions(fetched.spans) })
    expect(validation.valid).toBe(false)
    expect(validation.reasons.join("\n")).toContain("terminal finny.run.completed")
    expect(validation.reasons.join("\n")).toContain("unattributed")
    expect(validation.reasons.join("\n")).toContain("null trace IDs")
  })

  test("rejects per-span attribution and time-bound mismatches", () => {
    const spans = [
      {
        span_id: "span",
        trace_id: "trace",
        session_id: "ses-main",
        start_time: "2026-07-08T23:59:59Z",
        end_time: "2026-07-09T00:00:01Z",
        name: "finny.run.completed",
        attributes: { "finny.run_id": "other-run", "finny.main_session_id": "other-session" },
        resource: { attributes: { "openinference.project.name": "other-project" } },
      },
    ]
    const fetched = { spans, paginationComplete: true, pages: 1 }
    const validation = validateGrade({ args: args(), fetched, grades: gradeSessions(spans) })
    expect(validation.valid).toBe(false)
    expect(validation.runMismatchCount).toBe(1)
    expect(validation.projectMismatchCount).toBe(1)
    expect(validation.mainSessionMismatchCount).toBe(1)
    expect(validation.timeMismatchCount).toBe(1)
  })

  test("requires exactly one completion span", () => {
    const completion = {
      span_id: "span-1",
      trace_id: "trace",
      session_id: "ses-main",
      start_time: "2026-07-09T00:10:00Z",
      end_time: "2026-07-09T00:10:01Z",
      name: "finny.run.completed",
      attributes: { "finny.run_id": "run-1", "finny.main_session_id": "ses-main", "git.commit": "commit-1" },
      resource: { attributes: { "openinference.project.name": "run-1" } },
    }
    const spans = [
      completion,
      { ...completion, span_id: "span-2" },
      { ...completion, span_id: "span-3", name: "finny.agent.run" },
      { ...completion, span_id: "span-4", name: "finny.tool.execute" },
    ]
    const fetched = { spans, paginationComplete: true, pages: 1 }
    const validation = validateGrade({ args: args(), fetched, grades: gradeSessions(spans) })
    expect(validation.valid).toBe(false)
    expect(validation.completionSpanCount).toBe(2)
    expect(validation.reasons.join("\n")).toContain("multiple terminal")
  })

  test("accepts fully attributed child spans and rejects incomplete child relationships", () => {
    const base = {
      trace_id: "trace",
      session_id: "",
      start_time: "2026-07-09T00:10:00Z",
      end_time: "2026-07-09T00:10:01Z",
      attributes: {
        "finny.run_id": "run-1",
        "finny.main_session_id": "ses-main",
        "openinference.project.name": "run-1",
        "git.commit": "commit-1",
      },
    }
    const spans = [
      { ...base, span_id: "completion", name: "finny.run.completed", attributes: { ...base.attributes, "session.id": "ses-main" } },
      { ...base, span_id: "agent", name: "finny.agent.run", attributes: { ...base.attributes, "session.id": "ses-main" } },
      {
        ...base,
        span_id: "tool",
        name: "finny.tool.execute",
        attributes: {
          ...base.attributes,
          "session.id": "ses-child",
          "finny.parent_session_id": "ses-main",
          "finny.child_session_id": "ses-child",
        },
      },
    ]
    const fetched = { spans, paginationComplete: true, pages: 1 }
    expect(validateGrade({ args: args(), fetched, grades: gradeSessions(spans) }).valid).toBe(true)
    const malformed = spans.map((span) =>
      span.span_id === "tool" ? { ...span, attributes: { ...span.attributes, "finny.child_session_id": undefined } } : span,
    )
    expect(
      validateGrade({ args: args(), fetched: { ...fetched, spans: malformed }, grades: gradeSessions(malformed) })
        .sessionMismatchCount,
    ).toBe(1)
  })

  test("fails when a fully attributed child session contains a critical class", () => {
    const shared = {
      trace_id: "trace",
      session_id: "",
      start_time: "2026-07-09T00:10:00Z",
      end_time: "2026-07-09T00:10:01Z",
      attributes: {
        "finny.run_id": "run-1",
        "finny.main_session_id": "ses-main",
        "openinference.project.name": "run-1",
        "git.commit": "commit-1",
      },
    }
    const spans = [
      { ...shared, span_id: "completion", name: "finny.run.completed", attributes: { ...shared.attributes, "session.id": "ses-main" } },
      { ...shared, span_id: "agent", name: "finny.agent.run", attributes: { ...shared.attributes, "session.id": "ses-main" } },
      {
        ...shared,
        span_id: "child-tool",
        name: "finny.tool.execute",
        attributes: {
          ...shared.attributes,
          "session.id": "ses-child",
          "finny.parent_session_id": "ses-main",
          "finny.child_session_id": "ses-child",
          "tool.output": "Data quality failed",
        },
      },
    ]
    const fetched = { spans, paginationComplete: true, pages: 1 }
    const validation = validateGrade({ args: args(), fetched, grades: gradeSessions(spans) })
    expect(validation.valid).toBe(false)
    expect(validation.criticalSessionCount).toBe(1)
    expect(validation.reasons.join("\n")).toContain("ses-child=strict_quality_mismatch")
  })
})
