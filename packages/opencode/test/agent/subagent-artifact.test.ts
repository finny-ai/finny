import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { renderSubagentArtifactPointer } from "../../src/agent/subagent-artifact"

describe("renderSubagentArtifactPointer", () => {
  test("points at the news brief the news_agent wrote, with its heading", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-subagent-"))
    process.env.XDG_DATA_HOME = root
    const slug = "spy-1h-mean-reversion"
    const newsDir = path.join(root, "finny", "algos", slug, "data", "news")
    await fs.mkdir(newsDir, { recursive: true })
    await fs.writeFile(
      path.join(newsDir, "spy_1h_context.md"),
      "# SPY 1h Market Context\n\n- no material catalysts\n",
    )

    const pointer = await renderSubagentArtifactPointer("news_agent", slug)
    expect(pointer).toContain('<subagent-artifact agent="news_agent">')
    expect(pointer).toContain("file: data/news/spy_1h_context.md")
    expect(pointer).toContain("heading: SPY 1h Market Context")
    expect(pointer).toContain("</subagent-artifact>")
  })

  test("enriches news pointer lines with claims evidence counts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-subagent-claims-"))
    process.env.XDG_DATA_HOME = root
    const slug = "spy-1h-claims"
    const newsDir = path.join(root, "finny", "algos", slug, "data", "news")
    await fs.mkdir(newsDir, { recursive: true })
    await fs.writeFile(
      path.join(newsDir, "spy_claims.md"),
      [
        "# SPY Claims Note",
        "",
        "```json",
        JSON.stringify({
          schema: "finny.news.claims.v1",
          result: "OK",
          retrieved_at: "2026-07-09T12:00:00.000Z",
          claims: [
            {
              class: "sourced_fact",
              statement: "Fed minutes released",
              source_url: "https://example.com/a",
              provider: "google_news_rss",
              published_at: "2026-07-08T15:00:00.000Z",
              retrieved_at: "2026-07-09T12:00:00.000Z",
              excerpt: "minutes released",
            },
            {
              class: "market_data_fact",
              statement: "range 1%",
              dataset: "bars",
              symbol: "SPY",
              computation: "range",
            },
          ],
        }),
        "```",
      ].join("\n"),
    )

    const pointer = await renderSubagentArtifactPointer("news_agent", slug)
    expect(pointer).toContain("heading: SPY Claims Note")
    expect(pointer).toContain("evidence: 1 sourced_fact, 1 market_data_fact")
  })

  test("enriches news pointer with NO_SOURCED_CONTEXT when claims say so", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-subagent-nosrc-"))
    process.env.XDG_DATA_HOME = root
    const slug = "spy-1h-nosrc"
    const newsDir = path.join(root, "finny", "algos", slug, "data", "news")
    await fs.mkdir(newsDir, { recursive: true })
    await fs.writeFile(
      path.join(newsDir, "empty.md"),
      [
        "# Empty",
        "```json",
        JSON.stringify({
          schema: "finny.news.claims.v1",
          result: "NO_SOURCED_CONTEXT",
          claims: [{ class: "unavailable", source_class: "gdelt", reason: "timeout" }],
        }),
        "```",
      ].join("\n"),
    )

    const pointer = await renderSubagentArtifactPointer("news_agent", slug)
    expect(pointer).toContain("result: NO_SOURCED_CONTEXT")
  })

  test("returns empty string when nothing was written", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-subagent-"))
    process.env.XDG_DATA_HOME = root
    const slug = "empty-workspace"
    await fs.mkdir(path.join(root, "finny", "algos", slug, "data", "sec"), { recursive: true })
    expect(await renderSubagentArtifactPointer("sec_agent", slug)).toBe("")
  })

  test("points at sentiment artifacts for workflow evidence admission", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-subagent-sentiment-"))
    process.env.XDG_DATA_HOME = root
    const slug = "meta-1h-sentiment"
    const sentimentDir = path.join(root, "finny", "algos", slug, "data", "sentiment")
    await fs.mkdir(sentimentDir, { recursive: true })
    await fs.writeFile(
      path.join(sentimentDir, "META_2026-01-21_2026-07-21_sentiment.manifest.json"),
      JSON.stringify({ usable_for_parent: "yes" }),
    )

    const pointer = await renderSubagentArtifactPointer("sentiment_agent", slug)
    expect(pointer).toContain('<subagent-artifact agent="sentiment_agent">')
    expect(pointer).toContain("data/sentiment/META_2026-01-21_2026-07-21_sentiment.manifest.json")
  })

  test("returns empty string for an untracked subagent type", async () => {
    expect(await renderSubagentArtifactPointer("data_extractor", "any-slug")).toBe("")
  })
})
