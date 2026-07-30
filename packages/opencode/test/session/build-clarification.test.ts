import { describe, expect, test } from "bun:test"
import {
  buildDiscoveryQuestionIssues,
  canonicalBuildDiscoveryQuestions,
  requiresQuestionOnlyTools,
} from "@/session/build-clarification"

const user = (text: string) => ({
  info: { id: "msg_user", role: "user" },
  parts: [{ type: "text", text }],
})

const beatBuyAndHoldPrompt = "Build me a strategy that can beat buy and hold; you choose the idea"

function discoveryIssues(questions: Parameters<typeof buildDiscoveryQuestionIssues>[0]["questions"]) {
  return buildDiscoveryQuestionIssues({ prompt: beatBuyAndHoldPrompt, questions })
}

describe("vague build clarification boundary", () => {
  test("exposes only question before a completed structured clarification", () => {
    const messages = [user("Build me a strategy that can beat buy and hold; you choose the idea")]
    expect(requiresQuestionOnlyTools({ agent: "finny", messages })).toBe(true)

    messages.push({
      info: { id: "msg_assistant", role: "assistant", parentID: "msg_user" },
      parts: [
        {
          type: "tool",
          tool: "question",
          state: { status: "completed", output: "User has answered your questions: accepted." },
        },
      ],
    } as any)
    expect(requiresQuestionOnlyTools({ agent: "finny", messages })).toBe(false)
  })

  test("does not restrict explicit builds or conceptual questions", () => {
    expect(
      requiresQuestionOnlyTools({
        agent: "finny",
        messages: [user("Build SPY equity on 1d bars from 2025-01-01 to 2026-01-01")],
      }),
    ).toBe(false)
    expect(
      requiresQuestionOnlyTools({ agent: "finny", messages: [user("How does a Supertrend strategy work?")] }),
    ).toBe(false)
  })

  test("does not reduce a typed fund qualification envelope to question-only", () => {
    const productionEnvelope = JSON.stringify({
      schema: "FinnyFundQualificationPromptV1",
      candidateIdentity: {
        strategy_id: "xrp-mean-reversion-v1-q-8377d5d7b43b",
        controller_strategy_id: "xrp-mean-reversion-v1",
        slot: 1,
        market: "binance_usdm_testnet",
        symbol: "XRPUSDT",
      },
      symbol: "XRPUSDT",
      assetClass: "crypto",
      interval: "1m",
      requestedStart: "2026-01-27",
      requestedEnd: "2026-07-28",
      instruction:
        "Do not independently implement the strategy. Use candidateIdentity.strategy_id exactly as the algorithm name passed to finny_workspace_prepare.",
    })

    expect(
      requiresQuestionOnlyTools({
        agent: "finny",
        messages: [user(productionEnvelope)],
      }),
    ).toBe(false)
  })

  test("reports missing portfolio and evaluation gates", () => {
    const incomplete = discoveryIssues([
      {
        header: "Market",
        question: "Which symbol and asset class?",
        options: [{ label: "BTC", description: "Crypto" }],
      },
    ])
    expect(incomplete).toContain("capital")
    expect(incomplete).toContain("same-window buy-and-hold benchmark/alpha gate")
    expect(incomplete).toContain("out-of-sample gate")
  })

  test("requires absolute dates and recognizes an exact ISO window", () => {
    const durationOnly = discoveryIssues([
      {
        header: "Window",
        question: "Choose a backtest duration.",
        options: [{ label: "1 year", description: "Use one year" }],
      },
    ])
    expect(durationOnly).toContain("absolute start/end date window")

    const exactIsoWindow = discoveryIssues([
      {
        header: "Window",
        question: "Which evaluation window should Finny use?",
        options: [
          {
            label: "2025-07-15 to 2026-07-15",
            description: "Use these exact UTC dates with a primary provider and verified fallback data source.",
          },
        ],
      },
    ])
    expect(exactIsoWindow).not.toContain("absolute start/end date window")
  })

  test("accepts a compact option containing the full controlled surface", () => {
    expect(discoveryIssues([
      {
        header: "Default spec",
        question: "Use this full default build spec?",
        options: [
          {
            label: "Yes: SPY daily 2010-now",
            description:
              "SPY daily, 2010-01-01 to 2026-07-15, $100k, long-only cash, auto provider with verified fallback, last 25% OOS, target max drawdown under 20%, must beat same-window SPY buy-and-hold on Sharpe and max drawdown while remaining competitive on total return",
          },
          {
            label: "No: type my own",
            description: "Provide a custom symbol, asset class, interval, dates, capital, leverage, and success metric",
          },
        ],
      },
    ])).toEqual([])
  })

  test("accepts a complete multi-question discovery surface", () => {
    expect(discoveryIssues([
      {
        header: "Market",
        question: "Choose symbol/universe, asset class, and bar interval/timeframe.",
        options: [{ label: "BTC.USD 1d", description: "BTC crypto on daily bars" }],
      },
      {
        header: "Window",
        question: "Choose the absolute start date/end date backtest window and primary/fallback data provider.",
        options: [{ label: "1y + fallback", description: "One year; use a fallback data source" }],
      },
      {
        header: "Portfolio",
        question: "Choose capital, position constraints, direction/leverage, and maximum drawdown risk.",
        options: [{ label: "$10k long/flat", description: "One position, no leverage, max drawdown 15%" }],
      },
      {
        header: "Success",
        question:
          "Choose the acceptance success metric including positive total return, stitched OOS, and alpha versus the same-window buy-and-hold benchmark.",
        options: [{ label: "Strict gates", description: "Positive return, out-of-sample, and benchmark alpha" }],
      },
    ])).toEqual([])
  })

  test("canonical questions cover every field with deterministic absolute windows", () => {
    const canonical = canonicalBuildDiscoveryQuestions(new Date("2026-07-16T12:00:00Z"))
    expect(discoveryIssues(canonical)).toEqual([])
    expect(JSON.stringify(canonical)).toContain("2025-07-15 to 2026-07-15")
    expect(JSON.stringify(canonical)).toContain("2021-07-15 to 2026-07-15")
  })
})
