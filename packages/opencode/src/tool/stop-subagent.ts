import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { CronStorage } from "../cron"
import { Analytics } from "../analytics/tracker"

const parameters = z
  .object({
    jobID: z.string().optional().describe("Exact watcher job id to stop."),
    name: z.string().optional().describe("Exact watcher job name to stop."),
  })
  .refine((value) => Boolean(value.jobID) !== Boolean(value.name), {
    message: "Provide exactly one of jobID or name.",
  })

export const StopSubagentTool = Tool.define(
  "stop_subagent",
  Effect.succeed({
    description:
      "Stop one or more monitoring subagents created from the current session. This is a soft stop: an in-flight run may finish, but future ticks are disabled.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await Effect.runPromise(
          ctx.ask({
            permission: "stop_subagent",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          }),
        )

        const jobs = (await CronStorage.list()).filter((job) => {
          if (job.parentSessionID !== ctx.sessionID) return false
          if (params.jobID) return job.id === params.jobID
          return job.name === params.name
        })

        if (jobs.length === 0) {
          return {
            title: "No matching watcher",
            output: "No scheduled watcher from this session matched the provided identifier.",
            metadata: { stopped: 0 },
          }
        }

        const stopped: string[] = []
        for (const job of jobs) {
          const updated = await CronStorage.update(job.id, { enabled: false })
          if (updated) stopped.push(updated.id)
        }
        for (const jobID of stopped) {
          Analytics.track({
            eventType: "watcher",
            eventName: "watcher.stopped",
            sessionId: ctx.sessionID,
            metadata: { jobID, by: params.jobID ? "id" : "name" },
          })
        }

        return {
          title: `Stopped ${stopped.length} watcher${stopped.length === 1 ? "" : "s"}`,
          output: JSON.stringify(
            {
              stopped,
              softStop: true,
            },
            null,
            2,
          ),
          metadata: { stopped: stopped.length },
        }
      }),
  }),
)
