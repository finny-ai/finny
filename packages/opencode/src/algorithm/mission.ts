import matter from "gray-matter"
import z from "zod"

/**
 * Validation for the `schema_version: 3` mission.md contract described in
 * `algos/_template/README.md`. New algorithm saves must carry a complete v3
 * mission (frontmatter + Core 8 questionnaire); enforcement lives in the
 * finny_algorithm_save tool so the low-level Algorithm.save storage API stays
 * usable for migrations and tests.
 */
export namespace Mission {
  export const CORE8_IDS = [
    "market_universe",
    "timeframe_bar_interval",
    "strategy_family",
    "directional_thesis_regime",
    "entry_signal_idea",
    "exit_invalidation_rules",
    "risk_tolerance_max_drawdown",
    "backtest_window_success_metric",
  ] as const

  const ALGO_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

  const QuestionnaireItem = z
    .object({
      id: z.enum(CORE8_IDS),
      question: z.string().min(1),
      answer: z.string(),
      status: z.enum(["answered", "skipped"]),
    })
    .loose()
    .refine((item) => item.status === "skipped" || item.answer.trim().length > 0, {
      message: "answered items need a non-empty answer (use status: skipped with an empty answer instead)",
      path: ["answer"],
    })

  const NonEmpty = z.string().min(1)
  // The template stores numeric-looking values like max_drawdown_pct as quoted
  // strings; accept either and let downstream consumers coerce.
  const StringOrNumber = z.union([z.string().min(1), z.number()])

  const Frontmatter = z
    .object({
      schema_version: z.literal(3),
      name: z.string().regex(ALGO_NAME_RE, "must be kebab-case (lowercase, digits, hyphens)"),
      status: z.enum(["research", "backtested", "paper", "live", "retired"]),
      created: z.union([
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
        // YAML parses an unquoted 2026-06-10 as a Date.
        z.date(),
      ]),
      hypothesis: NonEmpty,
      scope: z
        .object({
          asset_class: z.enum(["equities", "crypto", "futures", "fx", "options", "mixed"]),
          universe: z.array(NonEmpty).min(1),
          horizon: z.enum(["intraday", "days", "weeks", "months"]),
        })
        .loose(),
      strategy: z
        .object({
          bar_interval: StringOrNumber,
          type: NonEmpty,
          direction: z.enum(["long", "short", "both"]),
          entry_signal: NonEmpty,
          risk_profile: NonEmpty,
          max_drawdown_pct: StringOrNumber,
          backtest_window: StringOrNumber,
          success_metric: NonEmpty,
        })
        .loose(),
      exit_conditions: NonEmpty,
      questionnaire: z.array(QuestionnaireItem),
    })
    .loose()

  export type MissionAssetClass = "equities" | "crypto" | "futures" | "fx" | "options" | "mixed"
  export type MissionHorizon = "intraday" | "days" | "weeks" | "months"
  export type MissionDirection = "long" | "short" | "both"
  export type MissionStatus = "research" | "backtested" | "paper" | "live" | "retired"

  export interface QuestionnaireAnswer {
    id: (typeof CORE8_IDS)[number]
    question: string
    answer: string
    status: "answered" | "skipped"
  }

  /** Deterministic input for Build-mode mission.md generation. */
  export interface RenderV3Input {
    name: string
    status?: MissionStatus
    created?: string
    hypothesis: string
    scope: {
      asset_class: MissionAssetClass
      universe: string[]
      horizon: MissionHorizon
    }
    strategy: {
      bar_interval: string | number
      type: string
      direction: MissionDirection
      entry_signal: string
      risk_profile: string
      max_drawdown_pct: string | number
      backtest_window: string | number
      success_metric: string
    }
    exit_conditions: string
    questionnaire: QuestionnaireAnswer[]
    /** Rendered after the closing `---` under `## User Preferences`. */
    userPreferences?: string
    bodyTitle?: string
    body?: string
  }

  function yamlBlockScalar(value: string): string {
    const normalized = value.replace(/\r\n/g, "\n").trimEnd()
    if (normalized.includes("\n")) {
      return `|\n${normalized
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`
    }
    if (/[:>#@`|]/.test(normalized) || /^[\s-]/.test(normalized)) return yamlQuoted(normalized)
    return normalized
  }

  function yamlQuoted(value: string | number): string {
    return JSON.stringify(String(value))
  }

  function renderQuestionnaire(items: QuestionnaireAnswer[]): string {
    return items
      .map((item) => {
        const answer = item.status === "skipped" ? '""' : yamlQuoted(item.answer)
        return [
          `  - id: ${item.id}`,
          `    question: ${yamlQuoted(item.question)}`,
          `    answer: ${answer}`,
          `    status: ${item.status}`,
        ].join("\n")
      })
      .join("\n")
  }

  /**
   * Render a schema_version: 3 mission.md string from structured Build inputs.
   * Uses block scalars for colon-heavy prose and keeps user preferences in the
   * markdown body after the closing frontmatter delimiter.
   */
  export function renderV3(input: RenderV3Input): string {
    const created = input.created ?? new Date().toISOString().slice(0, 10)
    const status = input.status ?? "research"
    const bodyTitle = input.bodyTitle ?? input.name
    const body = input.body?.trim()
    const prefs = input.userPreferences?.trim()
    const frontmatter = [
      "---",
      "schema_version: 3",
      `name: ${input.name}`,
      `status: ${status}`,
      `created: ${created}`,
      `hypothesis: ${yamlBlockScalar(input.hypothesis)}`,
      "scope:",
      `  asset_class: ${input.scope.asset_class}`,
      `  universe: [${input.scope.universe.map((sym) => yamlQuoted(sym)).join(", ")}]`,
      `  horizon: ${input.scope.horizon}`,
      "strategy:",
      `  bar_interval: ${yamlQuoted(input.strategy.bar_interval)}`,
      `  type: ${yamlQuoted(input.strategy.type)}`,
      `  direction: ${input.strategy.direction}`,
      `  entry_signal: ${yamlBlockScalar(input.strategy.entry_signal)}`,
      `  risk_profile: ${yamlQuoted(input.strategy.risk_profile)}`,
      `  max_drawdown_pct: ${yamlQuoted(input.strategy.max_drawdown_pct)}`,
      `  backtest_window: ${yamlQuoted(input.strategy.backtest_window)}`,
      `  success_metric: ${yamlBlockScalar(input.strategy.success_metric)}`,
      `exit_conditions: ${yamlBlockScalar(input.exit_conditions)}`,
      "questionnaire:",
      renderQuestionnaire(input.questionnaire),
      "---",
    ].join("\n")

    const sections = [`# ${bodyTitle}`, body ?? ""]
    if (prefs) sections.push("## User Preferences", prefs)
    return `${frontmatter}\n\n${sections.filter(Boolean).join("\n\n")}\n`
  }

  /**
   * Validate a mission.md string against the v3 contract. Returns a list of
   * human-readable issues; empty means valid.
   */
  export function validate(mission: string | undefined): string[] {
    if (!mission || mission.trim().length === 0) {
      return ["mission is missing — new algorithms require a schema_version: 3 mission.md with the Core 8 questionnaire"]
    }

    let parsed: { data: Record<string, unknown> }
    try {
      parsed = matter(mission)
    } catch (e: any) {
      return [`frontmatter is not valid YAML: ${e?.message ?? String(e)}`]
    }
    if (!mission.trimStart().startsWith("---") || Object.keys(parsed.data).length === 0) {
      return ["missing YAML frontmatter — mission.md must start with a `---` frontmatter block containing schema_version: 3"]
    }

    const result = Frontmatter.safeParse(parsed.data)
    const issues: string[] = []
    if (!result.success) {
      for (const issue of result.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)"
        issues.push(`${path}: ${issue.message}`)
      }
    }

    // Core 8 completeness — every id present exactly once. Run even when zod
    // found other issues so the agent gets the full picture in one pass.
    const items = Array.isArray(parsed.data.questionnaire) ? parsed.data.questionnaire : []
    const seen = new Map<string, number>()
    for (const item of items) {
      const id = typeof item === "object" && item !== null ? String((item as any).id ?? "") : ""
      if (id) seen.set(id, (seen.get(id) ?? 0) + 1)
    }
    for (const id of CORE8_IDS) {
      const count = seen.get(id) ?? 0
      if (count === 0) issues.push(`questionnaire: missing Core 8 item \`${id}\``)
      if (count > 1) issues.push(`questionnaire: duplicate Core 8 item \`${id}\``)
    }

    return issues
  }
}
