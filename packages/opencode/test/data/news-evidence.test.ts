import { describe, expect, test } from "bun:test"
import {
  NEWS_CLAIMS_SCHEMA,
  parseNewsClaimsBlock,
  validateNewsAgentTaskText,
  type NewsClaimsBlock,
} from "../../src/data/news-evidence"

const RETRIEVED = "2026-07-09T12:00:00.000Z"
const NOW = "2026-07-09T12:00:00.000Z"

function fence(block: unknown): string {
  return "```json\n" + JSON.stringify(block, null, 2) + "\n```"
}

function okClaims(overrides: Partial<NewsClaimsBlock> = {}): NewsClaimsBlock {
  return {
    schema: NEWS_CLAIMS_SCHEMA,
    result: "OK",
    identity: {
      requested_symbol: "SPY",
      requested_interval: "1h",
      requested_asset_class: "equity",
      requested_algorithm_name: "spy-1h-mean-reversion",
    },
    retrieved_at: RETRIEVED,
    claims: [
      {
        class: "sourced_fact",
        statement: "SPY saw elevated volume after Fed minutes release.",
        source_url: "https://news.google.com/rss/articles/example",
        provider: "google_news_rss",
        published_at: "2026-07-08T15:00:00.000Z",
        retrieved_at: RETRIEVED,
        excerpt: "SPY volume spiked following the release of Fed minutes",
      },
      {
        class: "market_data_fact",
        statement: "SPY 1h realized range over the last 5 sessions was 1.2%.",
        dataset: "workspace bars",
        symbol: "SPY",
        interval: "1h",
        window: "2026-07-01/2026-07-08",
        computation: "max(high)-min(low) / close over last 5 sessions",
      },
      {
        class: "model_hypothesis",
        statement: "Mean-reversion filters may underperform if vol regime stays elevated.",
      },
    ],
    ...overrides,
  }
}

describe("parseNewsClaimsBlock", () => {
  test("extracts finny.news.claims.v1 fenced JSON", () => {
    const text = `## Brief\n\n${fence(okClaims())}\n`
    const parsed = parseNewsClaimsBlock(text)
    expect(parsed.block).not.toBeNull()
    expect(parsed.block?.schema).toBe(NEWS_CLAIMS_SCHEMA)
    expect(parsed.block?.claims).toHaveLength(3)
  })

  test("accepts a finny.news.claims.v1 language-tagged fence", () => {
    const text = "```finny.news.claims.v1\n" + JSON.stringify(okClaims(), null, 2) + "\n```"
    const parsed = parseNewsClaimsBlock(text)
    expect(parsed.block).not.toBeNull()
    expect(parsed.block?.claims).toHaveLength(3)
  })

  test("returns parse error for missing block", () => {
    const parsed = parseNewsClaimsBlock("## Brief\n\nno claims here")
    expect(parsed.block).toBeNull()
    expect(parsed.parseError).toMatch(/no finny\.news\.claims/)
  })

  test("continues past a broken schema-tagged fence to a later valid claims block", () => {
    const broken = '```json\n{"schema":"finny.news.claims.v1","result":"OK",\n```'
    const good = fence(okClaims())
    const parsed = parseNewsClaimsBlock(`## Brief\n\n${broken}\n\n${good}`)
    expect(parsed.block).not.toBeNull()
    expect(parsed.block?.claims).toHaveLength(3)
    expect(parsed.parseError).toBeUndefined()
  })
})

describe("validateNewsAgentTaskText", () => {
  test("happy path: valid provenance yields evidence counts and annotated text", () => {
    const brief = [
      "## News Agent Brief: SPY",
      "- Claims result: OK",
      "",
      fence(okClaims()),
    ].join("\n")

    const result = validateNewsAgentTaskText({
      text: brief,
      workspaceSlug: "spy-1h-mean-reversion",
      context: {
        request_id: "ses_test",
        requested_symbol: "SPY",
        requested_interval: "1h",
        requested_asset_class: "equity",
        requested_algorithm_name: "spy-1h-mean-reversion",
      },
      now: NOW,
    })

    expect(result.ok).toBe(true)
    expect(result.evidenceCount).toEqual({ sourced_fact: 1, market_data_fact: 1 })
    expect(result.text).toContain("<news-evidence>")
    expect(result.text).toContain("sourced_fact=1")
    expect(result.text).toContain("market_data_fact=1")
    expect(result.text).toContain("hypotheses: 1")
    expect(result.text).toContain("## News Agent Brief: SPY")
  })

  test("unavailable providers only → deterministic NO_SOURCED_CONTEXT", () => {
    const block = okClaims({
      result: "NO_SOURCED_CONTEXT",
      claims: [
        {
          class: "unavailable",
          source_class: "google_news_rss",
          reason: "HTTP 503",
          recovery: "retry later",
        },
        {
          class: "unavailable",
          source_class: "gdelt",
          reason: "empty ArtList",
        },
        {
          class: "model_hypothesis",
          statement: "Spreads are probably wide today.",
        },
      ],
    })
    const result = validateNewsAgentTaskText({
      text: `Polished-looking brief about tight spreads.\n\n${fence(block)}`,
      workspaceSlug: "spy-1h-mean-reversion",
      context: { request_id: "ses_test", requested_symbol: "SPY" },
      now: NOW,
    })

    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/^NO_SOURCED_CONTEXT:/)
    expect(result.text).toContain("google_news_rss")
    expect(result.text).toContain("gdelt")
    expect(result.text).not.toContain("Polished-looking brief about tight spreads")
    expect(result.evidenceCount).toEqual({ sourced_fact: 0, market_data_fact: 0 })
  })

  test("future-dated published_at → future_dated violation, excluded from evidence", () => {
    const block = okClaims({
      claims: [
        {
          class: "sourced_fact",
          statement: "Future leak claim",
          source_url: "https://example.com/a",
          provider: "websearch",
          published_at: "2026-07-10T00:00:00.000Z",
          retrieved_at: RETRIEVED,
          excerpt: "this was published tomorrow",
        },
      ],
    })
    const result = validateNewsAgentTaskText({
      text: fence(block),
      workspaceSlug: "spy-1h-mean-reversion",
      now: NOW,
    })

    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/^NO_SOURCED_CONTEXT:/)
    expect(result.violations?.some((v) => v.kind === "future_dated")).toBe(true)
    expect(result.evidenceCount?.sourced_fact).toBe(0)
  })

  test("future event_time with valid published_at stays evidence (scheduled catalyst)", () => {
    const block = okClaims({
      claims: [
        {
          class: "sourced_fact",
          statement: "AAPL earnings scheduled for July 24 after close.",
          source_url: "https://example.com/earnings",
          provider: "yahoo_finance_rss",
          published_at: "2026-07-08T14:00:00.000Z",
          event_time: "2026-07-24T20:00:00.000Z",
          retrieved_at: RETRIEVED,
          excerpt: "AAPL reports Q3 results on July 24 after the close",
        },
      ],
    })
    const result = validateNewsAgentTaskText({
      text: fence(block),
      workspaceSlug: "aapl-1d-event",
      now: NOW,
    })

    expect(result.ok).toBe(true)
    expect(result.evidenceCount?.sourced_fact).toBe(1)
    expect(result.violations?.some((v) => v.kind === "future_dated")).toBe(false)
    expect(result.violations?.some((v) => v.kind === "scheduled_event")).toBe(true)
    expect(result.text).toContain("scheduled_event=1")
    expect(result.text).toContain("<news-evidence>")
  })

  test("stale source → flagged but still counts as evidence when otherwise valid", () => {
    const block = okClaims({
      claims: [
        {
          class: "sourced_fact",
          statement: "Old catalyst still cited",
          source_url: "https://example.com/old",
          provider: "yahoo_finance_rss",
          published_at: "2025-01-01T00:00:00.000Z",
          retrieved_at: RETRIEVED,
          excerpt: "announcement from January",
        },
      ],
    })
    const result = validateNewsAgentTaskText({
      text: `## Brief\n\n${fence(block)}`,
      workspaceSlug: "spy-1h-mean-reversion",
      now: NOW,
    })

    expect(result.ok).toBe(true)
    expect(result.evidenceCount?.sourced_fact).toBe(1)
    expect(result.violations?.some((v) => v.kind === "stale_source")).toBe(true)
    expect(result.text).toContain("stale_source=1")
  })

  test("conflicting sources → both cited, conflict flagged once per pair", () => {
    const block = okClaims({
      claims: [
        {
          class: "sourced_fact",
          statement: "Exchange says halt lifted at 10:00",
          source_url: "https://www.nasdaqtrader.com/a",
          provider: "exchange_notice",
          published_at: "2026-07-08T10:05:00.000Z",
          retrieved_at: RETRIEVED,
          excerpt: "trading resumed at 10:00",
          conflicts_with: [1],
        },
        {
          class: "sourced_fact",
          statement: "Wire says halt still active at 10:15",
          source_url: "https://news.google.com/rss/b",
          provider: "google_news_rss",
          published_at: "2026-07-08T10:20:00.000Z",
          retrieved_at: RETRIEVED,
          excerpt: "halt remains in effect",
          conflicts_with: [0],
        },
      ],
    })
    const result = validateNewsAgentTaskText({
      text: fence(block),
      workspaceSlug: "spy-1h-mean-reversion",
      now: NOW,
    })

    expect(result.ok).toBe(true)
    expect(result.evidenceCount?.sourced_fact).toBe(2)
    // One undirected pair → one violation entry per claim (not four).
    expect(result.violations?.filter((v) => v.kind === "conflict")).toHaveLength(2)
    expect(result.text).toContain("conflict=2")
  })

  test("missing provenance → downgraded, cannot satisfy evidence", () => {
    const block = okClaims({
      claims: [
        {
          class: "sourced_fact",
          statement: "Spreads are 2 bps",
          // missing source_url, published_at, retrieved_at, excerpt
        } as any,
        {
          class: "model_hypothesis",
          statement: "Therefore size down.",
        },
      ],
    })
    const result = validateNewsAgentTaskText({
      text: `Confident microstructure brief.\n\n${fence(block)}`,
      workspaceSlug: "spy-1h-mean-reversion",
      now: NOW,
    })

    expect(result.ok).toBe(false)
    expect(result.text).toMatch(/^NO_SOURCED_CONTEXT:/)
    expect(result.violations?.some((v) => v.kind === "missing_provenance")).toBe(true)
    expect(result.evidenceCount).toEqual({ sourced_fact: 0, market_data_fact: 0 })
  })

  test("malformed or absent claims block → NO_SOURCED_CONTEXT", () => {
    const absent = validateNewsAgentTaskText({
      text: "## News Agent Brief\n\n- Spreads look fine based on my knowledge.\n",
      workspaceSlug: "spy-1h-mean-reversion",
      now: NOW,
    })
    expect(absent.ok).toBe(false)
    expect(absent.text).toMatch(/^NO_SOURCED_CONTEXT:/)
    expect(absent.violations?.some((v) => v.kind === "malformed_claims")).toBe(true)

    const malformed = validateNewsAgentTaskText({
      text: '```json\n{"schema":"finny.news.claims.v1","result":"OK",\n```',
      workspaceSlug: "spy-1h-mean-reversion",
      now: NOW,
    })
    expect(malformed.ok).toBe(false)
    expect(malformed.text).toMatch(/^NO_SOURCED_CONTEXT:/)
  })

  test("identity mismatch is reported as an issue and visible in <news-evidence>", () => {
    const block = okClaims({
      identity: {
        requested_symbol: "QQQ",
        requested_interval: "1h",
        requested_asset_class: "equity",
        requested_algorithm_name: "spy-1h-mean-reversion",
      },
    })
    const result = validateNewsAgentTaskText({
      text: fence(block),
      workspaceSlug: "spy-1h-mean-reversion",
      context: {
        request_id: "ses_test",
        requested_symbol: "SPY",
        requested_interval: "1h",
        requested_asset_class: "equity",
      },
      now: NOW,
    })
    expect(result.ok).toBe(true)
    expect(result.issues.some((i) => /requested_symbol differs/.test(i))).toBe(true)
    expect(result.violations?.some((v) => v.kind === "identity_mismatch")).toBe(true)
    expect(result.text).toContain("identity_mismatch=1")
    expect(result.text).toContain("issues:")
    expect(result.text).toMatch(/identity\.requested_symbol differs/)
  })

  test("preserves BLOCKED replies so taskResultStatus still marks blocked", () => {
    const blocked = "BLOCKED: missing news topic"
    const result = validateNewsAgentTaskText({
      text: blocked,
      workspaceSlug: "spy-1h-mean-reversion",
      now: NOW,
    })
    expect(result.ok).toBe(false)
    expect(result.text).toBe(blocked)
    expect(result.text).toMatch(/\bBLOCKED:/)
    expect(result.text).not.toMatch(/^NO_SOURCED_CONTEXT:/)
  })

  test("preserves empty-subagent BLOCKED marker without rewriting", () => {
    const marker =
      "BLOCKED: subagent returned no usable output (final turn aborted or empty) — do not treat this as evidence."
    const result = validateNewsAgentTaskText({
      text: marker,
      workspaceSlug: "spy-1h-mean-reversion",
      now: NOW,
    })
    expect(result.text).toBe(marker)
  })
})
