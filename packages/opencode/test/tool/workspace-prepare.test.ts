import { describe, expect, test } from "bun:test"
import {
  ensureWorkspaceTodo,
  promptFromParams,
  resolveWorkspacePrepareWindow,
  workspacePrepareIntervalIssue,
  workspacePrepareClarificationBlock,
  workspacePrepareConfirmedIdentityLock,
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
  test("rejects duration-shaped values as bar intervals", () => {
    expect(workspacePrepareIntervalIssue("180d")).toContain("Unsupported bar interval")
    expect(workspacePrepareIntervalIssue("180d")).toContain("Valid bar intervals")
    expect(workspacePrepareIntervalIssue("6m")).toContain("Unsupported bar interval")
    expect(workspacePrepareIntervalIssue("1y")).toContain("Unsupported bar interval")
    expect(workspacePrepareIntervalIssue(undefined)).toBeUndefined()
  })

  test("accepts every supported canonical bar interval", () => {
    for (const interval of ["1m", "5m", "15m", "30m", "1h", "4h", "1d"]) {
      expect(workspacePrepareIntervalIssue(interval), interval).toBeUndefined()
    }
    // Display forms normalize to canonical values.
    expect(workspacePrepareIntervalIssue("15min")).toBeUndefined()
    expect(workspacePrepareIntervalIssue("daily")).toBeUndefined()
    expect(workspacePrepareIntervalIssue("hourly")).toBeUndefined()
  })

  test("creates the advertised todo.md scaffold", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "finny-workspace-todo-"))
    try {
      await ensureWorkspaceTodo(workspace)
      expect(await fs.readFile(path.join(workspace, "todo.md"), "utf8")).toBe("# Todo\n\n")
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("does not overwrite an existing workspace todo", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "finny-workspace-todo-"))
    const todoPath = path.join(workspace, "todo.md")
    const userTodo = "# Todo\n\n- [ ] Preserve this task\n"
    try {
      await fs.writeFile(todoPath, userTodo)
      await ensureWorkspaceTodo(workspace)
      expect(await fs.readFile(todoPath, "utf8")).toBe(userTodo)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

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

  test("clamps explicit crypto end dates that land on the incomplete current UTC day", () => {
    expect(
      resolveWorkspacePrepareWindow(
        {
          duration: "1y",
          startDate: "2025-07-17",
          endDate: "2026-07-17",
          interval: "4h",
          assetClass: "crypto",
        },
        new Date("2026-07-17T16:30:00Z"),
      ),
    ).toEqual({ startDate: "2025-07-17", endDate: "2026-07-16" })
  })

  test("allows safety clamp of a locked incomplete crypto end day without user re-approval", () => {
    const workflow = {
      identityStatus: "confirmed",
      identity: {
        symbols: { value: ["BTC.USD"] },
        assetClass: { value: "crypto" },
        interval: { value: "4h" },
        window: { value: { start: "2025-07-17", end: "2026-07-17" } },
      },
    }
    expect(
      workspacePrepareConfirmedIdentityLock({
        workflow,
        userPrompt: "BTC 4h supertrend",
        params: {
          symbol: "BTC.USD",
          assetClass: "crypto",
          interval: "4h",
          startDate: "2025-07-17",
          endDate: "2026-07-16",
        },
        now: new Date("2026-07-17T16:30:00Z"),
      }),
    ).toBeUndefined()
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

  test("locks confirmed identity against silent window shrink and interval thrash", () => {
    const workflow = {
      identityStatus: "confirmed",
      identity: {
        symbols: { value: ["SPY"] },
        assetClass: { value: "equity" },
        interval: { value: "15min" },
        window: { value: { start: "2026-01-16", end: "2026-07-16" } },
      },
    }
    expect(
      workspacePrepareConfirmedIdentityLock({
        workflow,
        userPrompt: "SPY 15min",
        params: {
          symbol: "SPY",
          assetClass: "equity",
          interval: "15min",
          startDate: "2026-05-16",
          endDate: "2026-07-16",
        },
      }),
    ).toContain("date window 2026-05-16→2026-07-16 changes confirmed identity")
    expect(
      workspacePrepareConfirmedIdentityLock({
        workflow,
        userPrompt: "SPY 15min",
        params: {
          symbol: "SPY",
          assetClass: "equity",
          interval: "1h",
          startDate: "2026-01-16",
          endDate: "2026-07-16",
        },
      }),
    ).toContain("interval 1h changes confirmed identity 15m")
    expect(
      workspacePrepareConfirmedIdentityLock({
        workflow,
        userPrompt: "SPY 15min",
        params: {
          symbol: "SPY",
          assetClass: "equity",
          interval: "15min",
          startDate: "2026-01-16",
          endDate: "2026-07-16",
        },
      }),
    ).toBeUndefined()
  })

  test("allows confirmed identity changes only with explicit user approval", () => {
    const workflow = {
      identityStatus: "confirmed",
      identity: {
        symbols: { value: ["SPY"] },
        assetClass: { value: "equity" },
        interval: { value: "15min" },
        window: { value: { start: "2026-01-16", end: "2026-07-16" } },
      },
    }
    expect(
      workspacePrepareConfirmedIdentityLock({
        workflow,
        userPrompt: "Switch to Hourly (1h) for the same SPY request",
        params: {
          symbol: "SPY",
          assetClass: "equity",
          interval: "1h",
          startDate: "2026-01-16",
          endDate: "2026-07-16",
        },
      }),
    ).toBeUndefined()
    expect(
      workspacePrepareConfirmedIdentityLock({
        workflow,
        userPrompt: "Use the shorter window 2026-06-01 to 2026-07-15",
        params: {
          symbol: "SPY",
          assetClass: "equity",
          interval: "15min",
          startDate: "2026-06-01",
          endDate: "2026-07-15",
        },
      }),
    ).toBeUndefined()
  })

  test("repairs a legacy fixed-day window when the original relative request resolves deterministically", () => {
    const workflow = {
      identityStatus: "confirmed",
      identity: {
        symbols: { value: ["META"] },
        assetClass: { value: "equity" },
        interval: { value: "1h" },
        window: { value: { start: "2026-01-23", end: "2026-07-22" } },
      },
    }

    expect(
      workspacePrepareConfirmedIdentityLock({
        workflow,
        userPrompt: "Build a META equity strategy every 1hr for 6 months or longer.",
        params: {
          symbol: "META",
          assetClass: "equity",
          interval: "1h",
          startDate: "2026-01-21",
          endDate: "2026-07-21",
        },
        now: new Date("2026-07-22T07:33:00Z"),
      }),
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

  test("excludes model-authored option descriptions from request identity", () => {
    // Regression: the parent model asked its own clarification round and its
    // option descriptions contained retention-limit prose ("180d lookback on
    // the research path", "capped at ~180d of history"). Those descriptions
    // were concatenated into the trusted question-answer context and parsed as
    // the user's requested bar interval, rejecting the user-approved 1h.
    const user = {
      info: { role: "user" },
      parts: [{ type: "text", text: "Verify this branch end to end: research BTC/USD and AAPL" }],
    }
    const assistant = {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "question",
          state: {
            status: "completed",
            input: {
              questions: [
                {
                  header: "Bar interval",
                  question: "What bar interval should each strategy use?",
                  options: [
                    {
                      label: "BTC 1h / AAPL 1d (Recommended)",
                      description:
                        "1h is the finest natively-supported crypto interval (180d lookback on the research path) and suits a mean-reversion/momentum hybrid on BTC.",
                    },
                    {
                      label: "1d for both",
                      description: "Simplest and most robust to costs; fewer trades, slower iteration.",
                    },
                  ],
                },
                {
                  header: "Backtest window",
                  question: "What research/backtest window should we use (same window for both assets)?",
                  options: [
                    {
                      label: "6 months (Recommended)",
                      description:
                        "Engine default; enough bars for walk-forward folds. Note: the 1h crypto research path is capped at ~180d of history.",
                    },
                  ],
                },
              ],
            },
            output: "User answered",
            title: "Asked 2 questions",
            metadata: {
              questions: [
                {
                  header: "Bar interval",
                  question: "What bar interval should each strategy use?",
                  options: [
                    { label: "BTC 1h / AAPL 1d (Recommended)", description: "1h is the finest natively-supported crypto interval (180d lookback on the research path)." },
                    { label: "1d for both", description: "Simplest and most robust to costs." },
                  ],
                },
                {
                  header: "Backtest window",
                  question: "What research/backtest window should we use (same window for both assets)?",
                  options: [
                    { label: "6 months (Recommended)", description: "Engine default. Note: the 1h crypto research path is capped at ~180d of history." },
                  ],
                },
              ],
              answers: [["BTC 1h / AAPL 1d (Recommended)"], ["6 months (Recommended)"]],
            },
            time: { start: 1, end: 2 },
          },
        },
      ],
    }
    const context = workspacePrepareUserContext([user, assistant] as SessionV1.WithParts[])
    // The user's chosen labels are present...
    expect(context).toContain("BTC 1h / AAPL 1d (Recommended)")
    expect(context).toContain("6 months (Recommended)")
    // ...but the model-authored description prose must not become request identity.
    expect(context).not.toContain("180d lookback")
    expect(context).not.toContain("capped at ~180d")
    const facts = parseRequestFacts(context)
    expect(facts.requested_interval).toBe("1h")
    // A legitimately approved 1h prepare must not be rejected as "conflicts with the user's 180d".
    expect(workspacePrepareIdentityConflict({ symbol: "BTC/USD", assetClass: "crypto", interval: "1h" }, context)).toBeUndefined()
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
