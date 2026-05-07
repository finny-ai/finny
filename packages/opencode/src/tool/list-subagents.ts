import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { CronStorage } from "../cron"

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
          .map((job) => ({
            id: job.id,
            name: job.name,
            kind: job.kind,
            enabled: job.enabled,
            schedule: job.scheduleSource,
            timezone: job.timezone,
            recurring: job.recurring,
            durable: job.durable,
            lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
            lastFiredAt: job.lastFiredAt ? new Date(job.lastFiredAt).toISOString() : null,
            failureCount: job.failureCount,
            expiresAt: job.expiresAt ? new Date(job.expiresAt).toISOString() : null,
          }))

        return {
          title: jobs.length === 0 ? "No scheduled watchers" : `${jobs.length} scheduled watcher${jobs.length === 1 ? "" : "s"}`,
          output: JSON.stringify(jobs, null, 2),
          metadata: { count: jobs.length },
        }
      }),
  }),
)
