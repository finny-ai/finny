import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { CronStorage, Schedule, WatcherState } from "../cron"

const parameters = z.object({})

export const ListSubagentsTool = Tool.define(
  "list_subagents",
  Effect.succeed({
    description:
      "List monitoring subagents scheduled from the current session. Returns only this session's watcher jobs.",
    parameters,
    execute: (_params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "list_subagents",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const jobs = (await CronStorage.list())
          .filter((job) => job.parentSessionID === ctx.sessionID)
          .map((job) => {
            const state = WatcherState.get(job.id)
            return {
              id: job.id,
              name: job.name,
              kind: job.kind,
              enabled: job.enabled,
              schedule: job.scheduleSource,
              timezone: job.timezone,
              recurring: job.recurring,
              durable: job.durable,
              estimatedRunsPerHour: Schedule.estimateRunsPerHour(job.schedule),
              lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
              lastFiredAt: job.lastFiredAt ? new Date(job.lastFiredAt).toISOString() : null,
              lastSnapshotAt: state?.lastSnapshotAt ? new Date(state.lastSnapshotAt).toISOString() : null,
              lastMaterialAt: state?.lastMaterialAt ? new Date(state.lastMaterialAt).toISOString() : null,
              pendingDelivery: state?.pendingStatus === WatcherState.PendingStatus.pending,
              lastDeliveryError: state?.lastDeliveryError ?? null,
              failureCount: job.failureCount,
              expiresAt: job.expiresAt ? new Date(job.expiresAt).toISOString() : null,
            }
          })

        return {
          title: jobs.length === 0 ? "No scheduled watchers" : `${jobs.length} scheduled watcher${jobs.length === 1 ? "" : "s"}`,
          output: JSON.stringify(jobs, null, 2),
          metadata: { count: jobs.length },
        }
      }),
  }),
)
