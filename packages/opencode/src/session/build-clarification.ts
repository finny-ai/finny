import { requiresIdentityClarification } from "@/algorithm/build-workflow/bind"

type MessageLike = {
  info: { id: string; role: string; parentID?: string }
  parts: ReadonlyArray<{
    type: string
    text?: string
    synthetic?: boolean
    tool?: string
    state?: { status?: string; output?: string }
  }>
}

const PRIMARY_BUILD_AGENTS = new Set(["finny", "build"])
const STRATEGY_BUILD_RE = /\b(?:build|create|make|design|develop|implement)\b[\s\S]*\b(?:strategy|algo(?:rithm)?)\b/i
const CONTROL_QUALIFICATION_SCHEMA_RE = /"schema"\s*:\s*"FinnyFundQualificationPromptV1"/

export function latestUserBuildPrompt(messages: ReadonlyArray<MessageLike>): {
  id: string
  text: string
} | null {
  const message = messages.findLast((item) => item.info.role === "user")
  if (!message) return null
  const text = message.parts
    .filter((part) => part.type === "text" && part.synthetic !== true && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim()
  return text ? { id: message.info.id, text } : null
}

export function isVagueStrategyBuild(input: { agent: string; messages: ReadonlyArray<MessageLike> }): boolean {
  if (!PRIMARY_BUILD_AGENTS.has(input.agent)) return false
  const latest = latestUserBuildPrompt(input.messages)
  // The fund controller supplies a complete, immutable qualification identity
  // and exact reference artifact in this typed envelope. It is not an opening
  // user build request, even though the embedded instruction may contain words
  // such as "implement" and "strategy". Keeping it behind the vague-build
  // discovery gate would expose only `question` and make every controller
  // qualification tool call unavailable.
  if (latest && CONTROL_QUALIFICATION_SCHEMA_RE.test(latest.text)) return false
  return Boolean(latest && STRATEGY_BUILD_RE.test(latest.text) && requiresIdentityClarification(latest.text))
}

function isCompletedQuestionAnswer(part: MessageLike["parts"][number]) {
  if (part.type !== "tool") return false
  if (part.tool !== "question") return false
  if (part.state?.status !== "completed") return false
  return part.state.output?.startsWith("User has answered your questions:") === true
}

function isClarificationResponse(message: MessageLike, userMessageID: string) {
  if (message.info.role !== "assistant" || message.info.parentID !== userMessageID) return false
  return message.parts.some(isCompletedQuestionAnswer)
}

export function hasCompletedBuildClarification(messages: ReadonlyArray<MessageLike>): boolean {
  const latest = latestUserBuildPrompt(messages)
  if (!latest) return false
  return messages.some((message) => isClarificationResponse(message, latest.id))
}

/** Keep a vague opening build turn at the trusted clarification boundary. */
export function requiresQuestionOnlyTools(input: { agent: string; messages: ReadonlyArray<MessageLike> }): boolean {
  return isVagueStrategyBuild(input) && !hasCompletedBuildClarification(input.messages)
}

type QuestionLike = {
  header: string
  question: string
  options: ReadonlyArray<{ label: string; description: string }>
}

/** Deterministic fallback when the model omits part of the controlled discovery surface. */
export function canonicalBuildDiscoveryQuestions(now = new Date()): QuestionLike[] {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  const start = (years: number) => {
    const value = new Date(end)
    value.setUTCFullYear(value.getUTCFullYear() - years)
    return value.toISOString().slice(0, 10)
  }
  const endDate = end.toISOString().slice(0, 10)
  const oneYearStart = start(1)
  const fiveYearStart = start(5)
  return [
    {
      header: "Market",
      question: "Which symbol/universe, asset class, and bar interval/timeframe should I use?",
      options: [
        { label: "BTC.USD crypto 1d", description: "Build for BTC.USD crypto spot on daily bars." },
        { label: "SPY equity 1d", description: "Build for the SPY equity ETF on daily bars." },
      ],
    },
    {
      header: "Window",
      question: "Which absolute start/end dates, capital, and primary/fallback data-provider setup should I use?",
      options: [
        {
          label: "1y, $10k, verified",
          description:
            `Use ${oneYearStart} to ${endDate}, $10,000 capital, the best primary provider, and a verified fallback data source.`,
        },
        {
          label: "Long history, $100k",
          description:
            `Use ${fiveYearStart} to ${endDate}, $100,000 capital, the best primary provider, and a verified fallback data source.`,
        },
      ],
    },
    {
      header: "Risk",
      question: "Which direction, position-count, leverage, and maximum-drawdown risk constraints should I enforce?",
      options: [
        {
          label: "Long/flat, DD 15%",
          description: "Long/flat only, one position, no leverage, and maximum drawdown at or below 15%.",
        },
        {
          label: "Long/flat, DD 20%",
          description: "Long/flat only, one position, no leverage, and maximum drawdown at or below 20%.",
        },
      ],
    },
    {
      header: "Success",
      question: "Which acceptance success metric should determine whether the strategy is reviewable?",
      options: [
        {
          label: "Strict positive gates",
          description:
            "Require positive total return, positive stitched OOS return, and positive alpha versus the same-window buy-and-hold benchmark.",
        },
        {
          label: "Risk-adjusted gates",
          description:
            "Require positive total return and stitched OOS return plus better Sharpe and drawdown than the same-window buy-and-hold benchmark.",
        },
      ],
    },
  ]
}

const DISCOVERY_FIELDS: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ["symbol/universe and asset class", /\b(?:symbol|universe|asset(?:\s+class)?)\b/i],
  [
    "bar interval/timeframe",
    /\b(?:interval|timeframe|bar\s+(?:size|interval)|daily|hourly|weekly|monthly|\d+\s*(?:m|min|minute|h|hour|d|day|w|week)s?)\b/i,
  ],
  [
    "absolute start/end date window",
    /\b(?:absolute\s+(?:start\s*\/\s*end\s+)?date\s+window|start\s+date[\s\S]*end\s+date|end\s+date[\s\S]*start\s+date)\b/i,
  ],
  ["capital", /(?:\b(?:capital|starting\s+cash|account\s+size)\b|\$\s*\d[\d,.]*\s*[kmb]?\b)/i],
  ["position and direction constraints", /\b(?:position|long\s*\/\s*flat|long-only|short|leverage)\b/i],
  ["risk/max drawdown", /\b(?:risk|max(?:imum)?\s+drawdown|drawdown)\b/i],
  ["primary/fallback data providers", /\b(?:provider|data\s+source|fallback)\b/i],
  ["success metric", /\b(?:success|target|acceptance|metric)\b/i],
]

export function buildDiscoveryQuestionIssues(input: {
  prompt: string
  questions: ReadonlyArray<QuestionLike>
}): string[] {
  const rendered = JSON.stringify(input.questions)
  const isoDates = rendered.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []
  const missing = DISCOVERY_FIELDS.filter(([label, pattern]) => {
    if (label === "absolute start/end date window" && isoDates.length >= 2) return false
    return !pattern.test(rendered)
  }).map(([label]) => label)
  if (/\b(?:beat|outperform)\b[\s\S]*\bbuy(?:\s+and\s+|-and-|\s*&\s*)hold\b/i.test(input.prompt)) {
    if (!/\b(?:buy(?:\s+and\s+|-and-|\s*&\s*)hold|benchmark|alpha)\b/i.test(rendered)) {
      missing.push("same-window buy-and-hold benchmark/alpha gate")
    }
    if (!/\b(?:out[- ]of[- ]sample|oos|walk[- ]forward|stitched)\b/i.test(rendered)) {
      missing.push("out-of-sample gate")
    }
  }
  return missing
}
