import type { FixtureScriptMode } from "./types"

type Json = Record<string, any>

const ALGORITHM_NAME = "spy-sma-crossover"

const STRATEGY = `from collections import deque

class Strategy:
    def __init__(self, broker, params=None):
        self.broker = broker
        p = params or {}
        self.fast = int(p.get("fast", 8))
        self.slow = int(p.get("slow", 24))
        self.risk_pct = float(p.get("risk_pct", 0.01))
        self.stop_pct = float(p.get("stop_pct", 0.015))
        self.prices = deque(maxlen=self.slow)
        self.previous_fast = None
        self.previous_slow = None
        self.entry_price = None

    def on_bar(self, symbol, bar):
        open_px = bar["open"]
        settled = bar["prev_close"]
        if settled is None or open_px <= 0:
            return
        if len(self.prices) < self.slow:
            self.prices.append(settled)
            return
        if self.fast <= 0 or self.slow <= 0:
            return
        values = list(self.prices)
        fast_ma = sum(values[-self.fast:]) / self.fast
        slow_ma = sum(values) / self.slow
        position = self.broker.position(symbol)
        bearish_cross = self.previous_fast is not None and self.previous_slow is not None and self.previous_fast >= self.previous_slow and fast_ma < slow_ma
        bullish_cross = self.previous_fast is not None and self.previous_slow is not None and self.previous_fast <= self.previous_slow and fast_ma > slow_ma
        if position == 0 and bearish_cross:
            equity = self.broker.equity()
            cash = self.broker.cash()
            stop_distance = open_px * self.stop_pct
            by_risk = (equity * self.risk_pct) / stop_distance if stop_distance > 0 else 0
            by_cash = (cash * 0.95) / open_px if cash > 0 else 0
            qty = int(min(by_risk, by_cash))
            if qty > 0:
                self.broker.buy(symbol, qty=qty)
                self.entry_price = open_px
        elif position > 0 and (bullish_cross or (self.entry_price is not None and open_px <= self.entry_price * (1 - self.stop_pct))):
            self.broker.sell(symbol, qty=position)
            self.entry_price = None
        self.previous_fast = fast_ma
        self.previous_slow = slow_ma
        self.prices.append(settled)
`

const LEAN_STRATEGY = `from AlgorithmImports import *

class Main(QCAlgorithm):
    """Deterministic SPY 5-minute SMA crossover LEAN harness candidate."""

    def Initialize(self):
        self.SetStartDate(2026, 1, 9)
        self.SetEndDate(2026, 7, 8)
        self.SetCash(10000)
        self.SetWarmUp(120, Resolution.Minute)
        self.symbol = self.AddEquity("SPY", Resolution.Minute).Symbol
        self.fast = SimpleMovingAverage(8)
        self.slow = SimpleMovingAverage(24)
        self.Consolidate(self.symbol, timedelta(minutes=5), self.OnConsolidated)
        self.previous_fast = None
        self.previous_slow = None
        self.entry_price = None

    def OnConsolidated(self, bar):
        if self.IsWarmingUp or not self.fast.IsReady or not self.slow.IsReady:
            return
        fast_ma = self.fast.Current.Value
        slow_ma = self.slow.Current.Value
        holdings = self.Portfolio[self.symbol].Quantity
        price = bar.Close
        bullish = self.previous_fast is not None and self.previous_slow is not None \\
            and self.previous_fast <= self.previous_slow and fast_ma > slow_ma
        bearish = self.previous_fast is not None and self.previous_slow is not None \\
            and self.previous_fast >= self.previous_slow and fast_ma < slow_ma
        if holdings == 0 and bearish and price > 0:
            qty = int((self.Portfolio.TotalPortfolioValue * 0.95) / price)
            if qty > 0:
                self.MarketOrder(self.symbol, qty)
                self.entry_price = price
        elif holdings > 0 and (bullish or (self.entry_price is not None and price <= self.entry_price * 0.985)):
            self.MarketOrder(self.symbol, -holdings)
            self.entry_price = None
        self.previous_fast = fast_ma
        self.previous_slow = slow_ma

    def OnData(self, slice):
        pass
`

const CORE8 = [
  "market_universe",
  "timeframe_bar_interval",
  "strategy_family",
  "directional_thesis_regime",
  "entry_signal_idea",
  "exit_invalidation_rules",
  "risk_tolerance_max_drawdown",
  "backtest_window_success_metric",
]

function mission(strategyType: string, algorithmName = ALGORITHM_NAME): string {
  return `---
schema_version: 4
name: ${algorithmName}
status: research
created: 2026-07-09
hypothesis: |
  A deterministic ${strategyType} rule can be evaluated without treating profitability as harness success.
scope:
  asset_class: equities
  universe: ["SPY"]
  horizon: intraday
strategy:
  bar_interval: "5m"
  type: "${strategyType}"
  direction: long
  entry_signal: |
    Enter on a settled-close moving-average crossover and execute at the next open.
  risk_profile: "Risk one percent of equity with whole-share cash caps."
  max_drawdown_pct: "10"
  backtest_window: "2026-01-09 through 2026-07-08"
  success_metric: |
    Complete the strict run and report measured return, Sharpe, and drawdown.
risk_contract:
  sizing_stop_distance_pct: 1.5
  protective_stop:
    mode: strategy_next_open
  drawdown:
    mode: halt_and_flatten_next_open
    limit_pct: 10
  max_positions: 1
exit_conditions: |
  Exit on the opposite crossover or a strategy-managed next-open protective threshold.
questionnaire:
${CORE8.map((id) => `  - id: ${id}\n    question: "Harness fixture question for ${id}?"\n    answer: "Deterministic fixture answer for ${id}."\n    status: answered`).join("\n")}
---

# ${algorithmName}

Deterministic offline harness candidate.

## User Preferences

- Capital: $10,000
- Exact window: 2026-01-09 through 2026-07-08
`
}

const CONFIG = JSON.stringify({
  symbol: "SPY",
  asset_class: "equity",
  interval: "5m",
  required_history_bars: 24,
  params: { fast: 8, slow: 24, risk_pct: 0.01, stop_pct: 0.015 },
  risk_contract: {
    sizing_stop_distance_pct: 1.5,
    protective_stop: { mode: "strategy_next_open" },
    drawdown: { mode: "halt_and_flatten_next_open", limit_pct: 10 },
    max_positions: 1,
  },
})

const LEAN_CONFIG = JSON.stringify({
  symbol: "SPY",
  asset_class: "equity",
  interval: "5m",
  required_history_bars: 24,
  params: { fast: 8, slow: 24 },
})

function providerConfig(url: string) {
  return {
    formatter: false,
    lsp: false,
    provider: {
      harness: {
        name: "Finny Harness Scripted Model",
        id: "harness",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          scripted: {
            id: "scripted",
            name: "Harness Scripted Model",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2026-07-09",
            limit: { context: 200_000, output: 20_000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "harness-local-only", baseURL: `${url}/v1` },
      },
    },
  }
}

function conversation(body: Json): any[] {
  if (Array.isArray(body.messages)) return body.messages
  if (Array.isArray(body.input)) return body.input
  return []
}

function serializedConversation(body: Json): string {
  const strings: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      strings.push(value)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== "object") return
    Object.values(value as Record<string, unknown>).forEach(visit)
  }
  visit(conversation(body))
  return strings.join("\n")
}

// @codescene(disable-all) Fixture call extraction intentionally normalizes the scripted protocol.
function callNames(body: Json): string[] {
  const names: string[] = []
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value.type === "function_call" && typeof value.name === "string") names.push(value.name)
    if (Array.isArray(value.tool_calls)) {
      for (const call of value.tool_calls) {
        const name = call?.function?.name
        if (typeof name === "string") names.push(name)
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "tools") continue
      visit(child)
    }
  }
  visit(conversation(body))
  return names
}

function availableToolNames(body: Json): Set<string> {
  const names = new Set<string>()
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const name = tool?.function?.name ?? tool?.name
    if (typeof name === "string") names.add(name)
  }
  return names
}

type ScriptReply =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; arguments: Record<string, unknown> }
  | { type: "http_error"; status: number; body: Record<string, unknown> }

function contextValue(text: string, field: string, fallback: string): string {
  const matches = [...text.matchAll(new RegExp(`(?:^|\\n)[- ]*${field}(?: when known)?[:=]\\s*([^\\n]+)`, "gi"))]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value) && value !== "MISSING" && !/^<.*>$/.test(value))
  return matches.at(-1) ?? fallback
}

function dataDigest(context: string) {
  const workspaceSlug = contextValue(context, "workspace_slug", ALGORITHM_NAME)
  const algorithmName = contextValue(context, "requested_algorithm_name", ALGORITHM_NAME)
  const requestId = contextValue(context, "request_id", "MISSING")
  const requestVersion = contextValue(context, "request_version", "MISSING")
  const requestContentHash = contextValue(context, "request_content_hash", "MISSING")
  return [
    "<data-extractor-manifest>",
    `requested_algorithm_name: ${algorithmName}`,
    `workspace_slug: ${workspaceSlug}`,
    `request_id: ${requestId}`,
    `request_version: ${requestVersion}`,
    `request_content_hash: ${requestContentHash}`,
    "requested_symbol: SPY",
    "actual_symbol: SPY",
    "requested_interval: 5m",
    "actual_interval: 5m",
    "requested_asset_class: equity",
    "actual_asset_class: equity",
    "requested_start: 2026-01-09",
    "requested_end: 2026-07-08",
    "actual_start: 2026-01-09T00:00:00.000Z",
    "actual_end: 2026-07-08T23:55:00.000Z",
    "artifact_paths: stock/SPY_5m_2026-01-09_2026-07-08.csv, stock/SPY_5m_2026-01-09_2026-07-08.manifest.json",
    "run_id: fixture-deterministic",
    "source: finny-harness-fixture",
    "coverage: complete",
    "usable_for_parent: yes",
    "</data-extractor-manifest>",
  ].join("\n")
}

type ScriptState = { dataTurns: number }

// @codescene(disable-all) Scripted replies intentionally encode the deterministic fixture protocol.
function scriptedReply(body: Json, mode: FixtureScriptMode, state: ScriptState): ScriptReply {
  const text = serializedConversation(body)
  if (/Generate a title for this conversation/i.test(text)) return { type: "text", text: "Finny Harness Fixture" }
  const calls = callNames(body)
  const available = availableToolNames(body)
  const mainTools = available.has("finny_workspace_prepare")
  const isData =
    (!mainTools && available.has("bash") && !available.has("websearch")) ||
    (/Data Extractor|data_extractor/i.test(text) && /allowed_data_dir|finny-subagent-context/i.test(text))
  const isNews =
    (!mainTools && available.has("websearch")) ||
    (/News Agent|news_agent/i.test(text) && /finny-subagent-context/i.test(text))

  if (isData) {
    const turn = state.dataTurns++
    if (turn === 0) {
      const workdir = contextValue(text, "allowed_data_dir", ".")
      const algorithm = contextValue(text, "requested_algorithm_name", ALGORITHM_NAME)
      const requestId = contextValue(text, "request_id", "")
      const requestVersion = contextValue(text, "request_version", "")
      const requestContentHash = contextValue(text, "request_content_hash", "")
      const lineage = [
        `algorithm=${encodeURIComponent(algorithm)}`,
        requestId ? `request_id=${encodeURIComponent(requestId)}` : "",
        requestVersion ? `request_version=${encodeURIComponent(requestVersion)}` : "",
        requestContentHash ? `request_content_hash=${encodeURIComponent(requestContentHash)}` : "",
      ]
        .filter(Boolean)
        .join("&")
      return {
        type: "tool",
        name: "bash",
        arguments: {
          command: `curl -fsS "$FINNY_HARNESS_MARKET_DATA_URL/v1/materialize?output_dir=$ALLOWED_DATA_DIR&${lineage}"`,
          workdir,
          timeout: 30_000,
          description: "Materializes deterministic harness market evidence",
        },
      }
    }
    return { type: "text", text: dataDigest(text) }
  }
  if (isNews) {
    return {
      type: "text",
      text: "requested_symbol: SPY\nrequested_interval: 5m\nrequested_start: 2026-01-09\nrequested_end: 2026-07-08\nNo external catalyst claim is needed for this deterministic harness run.",
    }
  }

  if (mode === "midstream_failure" && calls.includes("finny_workspace_prepare")) {
    return { type: "http_error", status: 400, body: { error: { message: "scripted mid-stream fixture failure" } } }
  }
  if (!calls.includes("finny_workspace_prepare")) {
    return {
      type: "tool",
      name: "finny_workspace_prepare",
      arguments: {
        algorithmName: ALGORITHM_NAME,
        symbol: "SPY",
        assetClass: "equity",
        interval: "5m",
        startDate: "2026-01-09",
        endDate: "2026-07-08",
        strategyIntent: "sma-crossover",
      },
    }
  }
  if (!calls.includes("task_batch_run") && !calls.includes("task")) {
    const dataPrompt =
      "Data request context: algorithm spy-sma-crossover; symbol SPY; equity; interval 5m; start date 2026-01-09; end date 2026-07-08. Materialize and verify the configured harness fixture."
    return {
      type: "tool",
      name: "task_batch_run",
      arguments: {
        tasks: [
          { description: "Extract deterministic SPY evidence", prompt: dataPrompt, subagent_type: "data_extractor" },
          {
            description: "Record deterministic context",
            prompt:
              "Context request: algorithm spy-sma-crossover; symbol SPY; equity; interval 5m; start date 2026-01-09; end date 2026-07-08. Do not use external sources.",
            subagent_type: "news_agent",
          },
        ],
      },
    }
  }
  if (!calls.includes("finny_algorithm_save")) {
    const strategyType = mode === "strategy_drift" ? "roc-momentum" : "sma-crossover"
    const candidateName = mode === "strategy_drift" ? "spy-roc-momentum" : ALGORITHM_NAME
    const isLean = process.env.FINNY_HARNESS_LEAN === "1"
    return {
      type: "tool",
      name: "finny_algorithm_save",
      arguments: {
        name: candidateName,
        code: isLean ? LEAN_STRATEGY : STRATEGY,
        saveMode: "new",
        language: "python",
        ...(isLean ? { runtimeProfile: "lean_python" } : {}),
        description:
          mode === "strategy_drift"
            ? "Deterministic SPY 5-minute ROC momentum contract drift candidate"
            : "Deterministic SPY 5-minute SMA crossover harness candidate",
        config: isLean ? LEAN_CONFIG : CONFIG,
        mission: mission(strategyType, candidateName),
        prefs: "Capital: $10,000\nRisk per trade: 1%\nData: exact verified harness fixture.",
        decisions: "2026-07-09: Use only settled closes for SMA decisions and next-open execution.",
        reasoning: "8/24 SMA windows fit the 24-bar warmup; whole-share sizing is capped by risk and cash.",
      },
    }
  }
  if (!calls.includes("finny_backtest")) {
    const candidateName = mode === "strategy_drift" ? "spy-roc-momentum" : ALGORITHM_NAME
    return {
      type: "tool",
      name: "finny_backtest",
      arguments: {
        algorithmName: candidateName,
        duration: "6m",
        interval: "5min",
        capital: "10000",
        startDate: "2026-01-09",
        endDate: "2026-07-08",
        dataQualityMode: "strict",
      },
    }
  }
  return {
    type: "text",
    // End with a user-facing question so Build workflow auto-iteration (when
    // harness mode is off) yields control instead of forcing another save loop.
    text: "Return: negative fixture result. Sharpe: below zero. Max drawdown: measured in the review packet. Eligibility: backtested only. Blockers: no promotion evidence. Next step: inspect the immutable review bundle; do not pivot strategy family. Would you like me to try a different approach?",
  }
}

function chatSse(reply: Exclude<ScriptReply, { type: "http_error" }>, sequence: number): Response {
  const id = "chatcmpl-finny-harness"
  const lines: unknown[] = [
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] },
  ]
  if (reply.type === "tool") {
    lines.push({
      id,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-${sequence}-${reply.name}`,
                type: "function",
                function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
              },
            ],
          },
        },
      ],
    })
    lines.push({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })
  } else {
    lines.push({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply.text } }] })
    lines.push({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
  }
  const stream = `${lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

function responsesSse(reply: Exclude<ScriptReply, { type: "http_error" }>, requestSequence: number): Response {
  let sequence = 1
  const output: unknown[] = [
    {
      type: "response.created",
      sequence_number: sequence++,
      response: { id: "resp_finny_harness", created_at: 0, model: "scripted", service_tier: null },
    },
  ]
  if (reply.type === "tool") {
    const args = JSON.stringify(reply.arguments)
    output.push({
      type: "response.output_item.added",
      sequence_number: sequence++,
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: `call-${requestSequence}-${reply.name}`,
        name: reply.name,
        arguments: "",
        status: "in_progress",
      },
    })
    output.push({
      type: "response.function_call_arguments.delta",
      sequence_number: sequence++,
      output_index: 0,
      item_id: "fc_1",
      delta: args,
    })
    output.push({
      type: "response.function_call_arguments.done",
      sequence_number: sequence++,
      output_index: 0,
      item_id: "fc_1",
      arguments: args,
    })
    output.push({
      type: "response.output_item.done",
      sequence_number: sequence++,
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: `call-${requestSequence}-${reply.name}`,
        name: reply.name,
        arguments: args,
        status: "completed",
      },
    })
  } else {
    output.push({
      type: "response.output_item.added",
      sequence_number: sequence++,
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    })
    output.push({
      type: "response.output_text.delta",
      sequence_number: sequence++,
      item_id: "msg_1",
      delta: reply.text,
      logprobs: null,
    })
    output.push({
      type: "response.output_item.done",
      sequence_number: sequence++,
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    })
  }
  output.push({
    type: "response.completed",
    sequence_number: sequence,
    response: {
      incomplete_details: null,
      service_tier: null,
      usage: {
        input_tokens: 1,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 1,
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  })
  return new Response(`${output.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

export type ScriptedModelServer = {
  readonly url: string
  readonly model: "harness/scripted"
  readonly configContent: string
  readonly requests: () => number
  readonly requestBodies: () => Json[]
  readonly stop: () => Promise<void>
}

// @codescene(disable-all) Fixture server startup owns the deterministic provider lifecycle.
export async function startScriptedModelServer(input: {
  port: number
  mode: FixtureScriptMode
  harnessMode: true
}): Promise<ScriptedModelServer> {
  if (input.harnessMode !== true) throw new Error("scripted model requires explicit harness mode")
  let count = 0
  const bodies: Json[] = []
  const state: ScriptState = { dataTurns: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return Response.json({ ok: true, model: "harness/scripted" })
      if (request.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(url.pathname)) {
        return new Response("not found\n", { status: 404 })
      }
      count += 1
      const body = (await request.json().catch(() => ({}))) as Json
      bodies.push(body)
      const reply = scriptedReply(body, input.mode, state)
      if (reply.type === "http_error") return Response.json(reply.body, { status: reply.status })
      return url.pathname.endsWith("/responses") ? responsesSse(reply, count) : chatSse(reply, count)
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  return {
    url,
    model: "harness/scripted",
    configContent: JSON.stringify(providerConfig(url)),
    requests: () => count,
    requestBodies: () => [...bodies],
    stop: async () => {
      await server.stop(true)
    },
  }
}

export const SCRIPTED_ALGORITHM_NAME = ALGORITHM_NAME
