import { describe, expect, test } from "bun:test"
import {
  promptFromParams,
  resolveWorkspacePrepareWindow,
  workspacePrepareClarificationBlock,
  workspacePrepareIdentityConflict,
  workspacePrepareUserContext,
} from "../../src/tool/workspace-prepare"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { findLatestReviewPacketInRoots } from "../../src/tool/review-packet"
import { parseRequestFacts } from "../../src/agent/request-identity"
import { canonicalBuildDiscoveryQuestions } from "../../src/session/build-clarification"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

describe("workspace prepare request context", () => {
  test("resolves a one-year duration to an absolute UTC date window", () => {
    expect(
      resolveWorkspacePrepareWindow({ duration: "1y", interval: "1d" }, new Date("2026-07-16T18:30:00-04:00")),
    ).toEqual({
      startDate: "2025-07-15",
      endDate: "2026-07-15",
    })
  })

  test("ends an open intraday equity window on the last completed session", () => {
    expect(
      resolveWorkspacePrepareWindow(
        { duration: "6m", interval: "5m", assetClass: "equity" },
        new Date("2026-07-16T12:40:00-04:00"),
      ),
    ).toEqual({ startDate: "2026-01-15", endDate: "2026-07-15" })
  })

  test("uses today's equity session only after the close and SIP delay", () => {
    expect(
      resolveWorkspacePrepareWindow(
        { duration: "6m", interval: "5m", assetClass: "equity" },
        new Date("2026-07-16T16:14:59-04:00"),
      ),
    ).toEqual({ startDate: "2026-01-15", endDate: "2026-07-15" })
    expect(
      resolveWorkspacePrepareWindow(
        { duration: "6m", interval: "5m", assetClass: "equity" },
        new Date("2026-07-16T16:15:00-04:00"),
      ),
    ).toEqual({ startDate: "2026-01-16", endDate: "2026-07-16" })
  })

  test("skips non-trading days when resolving an equity duration window", () => {
    expect(
      resolveWorkspacePrepareWindow(
        { duration: "1m", interval: "15m", assetClass: "equity" },
        new Date("2026-07-20T08:00:00-04:00"),
      ),
    ).toEqual({ startDate: "2026-06-17", endDate: "2026-07-17" })
  })

  test("ends crypto intraday duration windows on the last complete UTC day", () => {
    expect(
      resolveWorkspacePrepareWindow(
        { duration: "1m", interval: "5m", assetClass: "crypto" },
        new Date("2026-07-16T18:30:00Z"),
      ),
    ).toEqual({ startDate: "2026-06-15", endDate: "2026-07-15" })
  })

  test("preserves explicit dates when duration is also supplied", () => {
    expect(
      resolveWorkspacePrepareWindow(
        { duration: "1y", startDate: "2024-01-02", endDate: "2025-01-02" },
        new Date("2026-07-16T00:00:00Z"),
      ),
    ).toEqual({ startDate: "2024-01-02", endDate: "2025-01-02" })
  })

  test("clamps calendar-month subtraction at month end", () => {
    expect(resolveWorkspacePrepareWindow({ duration: "one month" }, new Date("2026-03-31T12:00:00Z"))).toEqual({
      startDate: "2026-02-28",
      endDate: "2026-03-31",
    })
  })

  test("rejects a partial explicit date window", () => {
    expect(resolveWorkspacePrepareWindow({ duration: "1y", startDate: "2025-07-16" })).toEqual({
      error:
        "Incomplete date window: provide both startDate and endDate, or omit both and provide a supported duration.",
    })
  })

  test("puts structured dates before summary dates", () => {
    const prompt = promptFromParams(
      {
        requestSummary: "Earlier context mentions 2023-01-01 and 2023-06-01.",
        startDate: "2024-07-10",
        endDate: "2026-07-10",
      },
      "",
    )
    expect(prompt.startsWith("date window 2024-07-10 to 2026-07-10")).toBe(true)
  })

  test("keeps structured SPY identity ahead of SMA(200) prose", () => {
    const prompt = promptFromParams(
      {
        requestSummary: "Build a named SMA(200) strategy; older notes called this a 200d setup.",
        algorithmName: "spy-sma-200",
        symbol: "SPY",
        assetClass: "equity",
        interval: "1d",
        startDate: "2018-01-01",
        endDate: "2025-12-31",
      },
      "",
    )
    expect(parseRequestFacts(prompt)).toMatchObject({
      requested_symbol: "SPY",
      requested_interval: "1d",
      requested_asset_class: "equity",
    })
    expect(prompt.startsWith("algorithm spy-sma-200; symbol SPY; asset class equity; interval 1d")).toBe(true)
    expect(prompt.indexOf("2018-01-01")).toBeLessThan(prompt.indexOf("200d"))
  })

  test("rejects a proxy symbol that conflicts with the latest user request", () => {
    const result = workspacePrepareIdentityConflict(
      { symbol: "VOO", assetClass: "equity", interval: "15min" },
      "VFV 15min",
    )
    expect(result).toContain("symbol VOO conflicts with the user's VFV")
    expect(result).toContain("Do not substitute a proxy ticker")
  })

  test("accepts normalized spelling of the user's exact identity", () => {
    expect(
      workspacePrepareIdentityConflict(
        { symbol: "VFV", assetClass: "equity", interval: "15m" },
        "Build a VFV 15-minute strategy",
      ),
    ).toBeUndefined()
  })

  test("rejects model-invented workspace identity before the user clarifies", () => {
    expect(
      workspacePrepareClarificationBlock(
        {
          requestSummary: "Beat buy-and-hold with a BTC trend strategy.",
          algorithmName: "supertrend-btc",
          symbol: "BTC-USD",
          assetClass: "crypto",
          interval: "1d",
          duration: "1y",
        },
        "Build me a strategy that can beat buy and hold; you choose the idea",
      ),
    ).toContain("explicit user clarification")
    expect(
      workspacePrepareClarificationBlock(
        { symbol: "SPY", assetClass: "equity", interval: "1d", duration: "6m" },
        "Use SPY equity, 1d bars, trailing 6 months, and long/flat positions.",
      ),
    ).toBeUndefined()
    expect(
      workspacePrepareClarificationBlock(
        { requestSummary: "SPY momentum strategy to beat buy-and-hold" },
        "Build me a strategy that can beat buy and hold; you choose the idea",
      ),
    ).toContain("explicit user clarification")
  })

  test("trusts completed question answers but not assistant-authored identity", () => {
    const user = {
      info: { role: "user" },
      parts: [{ type: "text", text: "Build me a strategy that can beat buy and hold; you choose the idea" }],
    }
    const assistant = {
      info: { role: "assistant" },
      parts: [
        { type: "text", text: "I will choose BTC for you." },
        {
          type: "tool",
          tool: "question",
          state: {
            status: "completed",
            input: { questions: [{ question: "Confirm the requested market and window." }] },
            output: "User answered",
            title: "Asked 1 question",
            metadata: { answers: [["SPY equity, 1d bars, 2026-01-16 to 2026-07-16"]] },
            time: { start: 1, end: 2 },
          },
        },
      ],
    }
    const context = workspacePrepareUserContext([user, assistant] as SessionV1.WithParts[])
    expect(context).toContain("SPY equity, 1d bars, 2026-01-16 to 2026-07-16")
    expect(context).not.toContain("choose BTC")
    expect(
      workspacePrepareClarificationBlock(
        {
          symbol: "SPY",
          assetClass: "equity",
          interval: "1d",
          startDate: "2026-01-16",
          endDate: "2026-07-16",
        },
        context,
      ),
    ).toBeUndefined()
  })

  test("uses canonical asked-question metadata and descriptions as trusted identity", () => {
    const questions = canonicalBuildDiscoveryQuestions(new Date("2026-07-16T12:00:00Z"))
    const user = {
      info: { role: "user" },
      parts: [{ type: "text", text: "Build me a strategy that can beat buy and hold; you choose the idea" }],
    }
    const assistant = {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "question",
          state: {
            status: "completed",
            input: { questions: [{ question: "Which setup?", options: [] }] },
            output: "User answered",
            title: "Asked 4 questions",
            metadata: {
              questions,
              answers: [
                ["BTC.USD crypto 1d"],
                ["1y, $10k, verified"],
                ["Long/flat, DD 15%"],
                ["Strict positive gates"],
              ],
            },
            time: { start: 1, end: 2 },
          },
        },
      ],
    }
    const context = workspacePrepareUserContext([user, assistant] as SessionV1.WithParts[])
    expect(context).toContain("2025-07-15 to 2026-07-15")
    expect(parseRequestFacts(context)).toMatchObject({
      requested_symbol: "BTC",
      requested_asset_class: "crypto",
      requested_interval: "1d",
    })
    expect(
      workspacePrepareIdentityConflict({ symbol: "BTC.USD", assetClass: "crypto", interval: "1d" }, context),
    ).toBeUndefined()
  })
})

describe("existing review packet lookup", () => {
  test("finds the newest packet without requiring an experiment id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-review-lookup-"))
    try {
      const store = path.join(root, "algorithms", "algo-review")
      const older = path.join(store, "reviews", "exp-old", "review.html")
      const latest = path.join(store, "reviews", "exp-latest", "review.html")
      await fs.mkdir(path.dirname(older), { recursive: true })
      await fs.mkdir(path.dirname(latest), { recursive: true })
      await fs.writeFile(older, "older")
      await fs.writeFile(latest, "latest")
      const now = new Date()
      await fs.utimes(older, new Date(now.getTime() - 10_000), new Date(now.getTime() - 10_000))
      expect(await findLatestReviewPacketInRoots([store])).toBe(latest)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
