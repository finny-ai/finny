import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"
import { parseConfig } from "../algorithm/strategy-params"
import { CronStorage, Schedule, Job, WatcherState } from "../cron"
import { Analytics } from "../analytics/tracker"

const RECURRING_TTL_MS = 7 * 24 * 60 * 60 * 1000
const SOFT_RUNS_PER_HOUR = 20
const HARD_RUNS_PER_HOUR = 30

const parameters = z.object({
  algorithm: z.string().describe("Saved algorithm name or algorithmId to monitor."),
  cron: z.string().describe("5-field cron expression or market alias for the monitoring cadence."),
  recurring: z
    .boolean()
    .default(true)
    .describe("Whether the watcher should keep running until it expires or is stopped."),
  durable: z
    .boolean()
    .default(false)
    .describe("Whether the watcher should survive a Finny restart. Default false keeps it session-scoped."),
  timezone: z
    .string()
    .optional()
    .describe("IANA timezone for the cron expression. Defaults to the current local timezone."),
  notes: z
    .string()
    .optional()
    .describe("Extra monitoring instructions, for example drawdown limits or special conditions to watch for."),
})

function buildPrompt(input: {
  algorithm: Algorithm.Info
  cron: string
  notes?: string
}) {
  const config = parseConfig(input.algorithm.config)
  return [
    "You are a monitoring subagent for a deployed trading algorithm.",
    "",
    "Use finny_monitor_snapshot first. If needed, use finny_algorithm_get and finny_backtest_history for context.",
    "",
    "Algorithm context:",
    `- name: ${input.algorithm.name}`,
    `- algorithmId: ${input.algorithm.algorithmId}`,
    `- status: ${input.algorithm.status}`,
    `- symbol: ${config.symbol ?? "unknown"}`,
    `- brokerage: ${config.brokerage ?? "unknown"}`,
    `- interval: ${config.interval ?? "unknown"}`,
    "",
    "Report only material changes worth waking the controller agent for:",
    "- account equity move >= 2% since the last trading day",
    "- symbol move >= 2% intraday",
    "- position changed materially or flipped between flat and non-flat",
    "- anything explicitly called out in the notes below",
    "",
    input.notes ? `Notes: ${input.notes}` : "Notes: none",
    "",
    "Keep the response to one short paragraph.",
    'If nothing material changed, respond exactly: "No change."',
  ].join("\n")
}

export const ScheduleSubagentTool = Tool.define(
  "schedule_subagent",
  Effect.succeed({
    description:
      "Schedule a monitoring subagent for the current session. The watcher wakes on a cron cadence, checks the algorithm, and wakes this same session only when it has a material update. Recurring watchers auto-expire after 7 days unless stopped earlier.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise<
        Tool.ExecuteResult<{
          created: boolean
          jobID: string | null
          algorithmId: string | null
        }>
      >(async () => {
        await Effect.runPromise(
          ctx.ask({
            permission: "schedule_subagent",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          }),
        )

        const timezone = params.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York")
        const parsed = Schedule.parse(params.cron, timezone)
        const estimatedRunsPerHour = Schedule.estimateRunsPerHour(parsed.cron)
        const existingSessionRuns = (await CronStorage.list())
          .filter((job) => job.parentSessionID === ctx.sessionID && job.enabled)
          .reduce((sum, job) => sum + Schedule.estimateRunsPerHour(job.schedule), 0)
        const sessionEstimatedRunsPerHour = existingSessionRuns + estimatedRunsPerHour
        if (sessionEstimatedRunsPerHour > HARD_RUNS_PER_HOUR) {
          Analytics.track({
            eventType: "watcher",
            eventName: "watcher.schedule.blocked",
            sessionId: ctx.sessionID,
            metadata: {
              reason: "hard_runs_per_hour_exceeded",
              estimatedRunsPerHour,
              sessionEstimatedRunsPerHour,
              hardCap: HARD_RUNS_PER_HOUR,
            },
          })
          return {
            title: "Watcher schedule blocked",
            output: JSON.stringify(
              {
                created: false,
                reason: `This schedule would raise the session to ${sessionEstimatedRunsPerHour.toFixed(2)} estimated watcher runs/hour, above the hard cap of ${HARD_RUNS_PER_HOUR}.`,
                estimatedRunsPerHour,
                sessionEstimatedRunsPerHour,
              },
              null,
              2,
            ),
            metadata: { created: false, jobID: null, algorithmId: null },
          }
        }
        const algorithm = await Algorithm.resolve(params.algorithm)
        if (!algorithm) {
          return {
            title: "Algorithm not found",
            output: `No saved algorithm matched "${params.algorithm}".`,
            metadata: { created: false, jobID: null, algorithmId: null },
          }
        }

        const input: Job.Input = {
          kind: "prompt",
          name: `watch ${algorithm.name}`,
          schedule: parsed.cron,
          scheduleSource: params.cron,
          marketAware: parsed.marketAware,
          timezone: parsed.timezone,
          enabled: true,
          parentSessionID: ctx.sessionID,
          recurring: params.recurring,
          durable: params.durable,
          expiresAt: params.recurring ? Date.now() + RECURRING_TTL_MS : undefined,
          notification: {
            title: `Watcher: ${algorithm.name}`,
          },
          prompt: {
            agent: "watcher",
            text: buildPrompt({
              algorithm,
              cron: params.cron,
              notes: params.notes,
            }),
          },
        }

        const job = await CronStorage.create(input)
        WatcherState.upsert({
          jobID: job.id,
          parentSessionID: ctx.sessionID,
          algorithmID: algorithm.algorithmId,
          algorithmName: algorithm.name,
        })
        const cfgForTrack = parseConfig(algorithm.config)
        Analytics.track({
          eventType: "watcher",
          eventName: "watcher.scheduled",
          sessionId: ctx.sessionID,
          metadata: {
            jobID: job.id,
            algorithmId: algorithm.algorithmId,
            algorithmName: algorithm.name,
            symbol: cfgForTrack.symbol ?? null,
            brokerage: cfgForTrack.brokerage ?? null,
            interval: cfgForTrack.interval ?? null,
            schedule: job.scheduleSource,
            normalizedCron: parsed.cron,
            timezone: parsed.timezone,
            recurring: params.recurring,
            durable: params.durable,
            estimatedRunsPerHour,
            sessionEstimatedRunsPerHour,
            notes: params.notes ?? null,
          },
        })
        const warning =
          sessionEstimatedRunsPerHour > SOFT_RUNS_PER_HOUR
            ? `Warning: this session is now estimated at ${sessionEstimatedRunsPerHour.toFixed(2)} watcher runs/hour.`
            : undefined
        return {
          title: `Scheduled watcher for ${algorithm.name}`,
          output: JSON.stringify(
            {
              jobID: job.id,
              name: job.name,
              algorithmId: algorithm.algorithmId,
              algorithmName: algorithm.name,
              schedule: job.scheduleSource,
              timezone: job.timezone,
              recurring: job.recurring,
              durable: job.durable,
              expiresAt: job.expiresAt ? new Date(job.expiresAt).toISOString() : null,
              estimatedRunsPerHour,
              sessionEstimatedRunsPerHour,
              warning,
            },
            null,
            2,
          ),
          metadata: {
            created: true,
            jobID: job.id,
            algorithmId: algorithm.algorithmId,
          },
        }
      }),
  }),
)
