import z from "zod"
import { setTimeout as sleep } from "node:timers/promises"
import { Identifier } from "@/id/id"
import { fn } from "@/util/fn"
import { ConvexWorkspaces } from "@/storage/convex/workspaces"
import { Project } from "@/project/project"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util/log"
import { Config } from "./config"
import { getAdaptor } from "./adaptors"
import { WorkspaceInfo } from "./types"
import { parseSSE } from "./sse"

export namespace Workspace {
  export const Event = {
    Ready: BusEvent.define(
      "workspace.ready",
      z.object({
        name: z.string(),
      }),
    ),
    Failed: BusEvent.define(
      "workspace.failed",
      z.object({
        message: z.string(),
      }),
    ),
  }

  export const Info = WorkspaceInfo.meta({
    ref: "Workspace",
  })
  export type Info = z.infer<typeof Info>

  function fromRow(row: {
    id: string
    branch?: string | null
    project_id: string
    config: any
  }): Info {
    return {
      id: row.id,
      branch: row.branch ?? null,
      projectID: row.project_id,
    }
  }

  const CreateInput = z.object({
    id: Identifier.schema("workspace").optional(),
    type: Info.shape.type,
    branch: Info.shape.branch,
    projectID: Info.shape.projectID,
    extra: Info.shape.extra,
  })

  export const create = fn(CreateInput, async (input) => {
    const id = Identifier.ascending("workspace", input.id)
    const adaptor = await getAdaptor(input.type)

    const config = await adaptor.configure({ ...input, id, name: null, directory: null })

    const info: Info = {
      id,
      type: config.type,
      branch: config.branch ?? null,
      name: config.name ?? null,
      directory: config.directory ?? null,
      extra: config.extra ?? null,
      projectID: input.projectID,
    }

        await ConvexWorkspaces.create({
          id: info.id,
          branch: info.branch ?? undefined,
          project_id: info.projectID,
          config: info.config,
        })
        .run()
    })

    await adaptor.create(config)
    return info
  })

  export async function list(project: Project.Info) {
    const rows = await ConvexWorkspaces.listByProject(project.id)
    return rows.map((row: any) => fromRow(row)).sort((a: Info, b: Info) => a.id.localeCompare(b.id))
  }

  export const get = fn(Identifier.schema("workspace"), async (id) => {
    const row = await ConvexWorkspaces.getById(id)
    if (!row) return
    return fromRow(row)
  })

  export const remove = fn(Identifier.schema("workspace"), async (id) => {
    const row = await ConvexWorkspaces.getById(id)
    if (row) {
      const info = fromRow(row)
      await getAdaptor(info.config).remove(info.config)
      await ConvexWorkspaces.remove(id)
      return info
    }
  })
  const log = Log.create({ service: "workspace-sync" })

  async function workspaceEventLoop(space: Info, stop: AbortSignal) {
    while (!stop.aborted) {
      const adaptor = await getAdaptor(space.type)
      const res = await adaptor.fetch(space, "/event", { method: "GET", signal: stop }).catch(() => undefined)
      if (!res || !res.ok || !res.body) {
        await sleep(1000)
        continue
      }
      await parseSSE(res.body, stop, (event) => {
        GlobalBus.emit("event", {
          directory: space.id,
          payload: event,
        })
      })
      // Wait 250ms and retry if SSE connection fails
      await sleep(250)
    }
  }

  export async function startSyncing(project: Project.Info) {
    const stop = new AbortController()
    const spaces = (await list(project)).filter((space: Info) => space.config.type !== "worktree")

    spaces.forEach((space: Info) => {
      void workspaceEventLoop(space, stop.signal).catch((error) => {
        log.warn("workspace sync listener failed", {
          workspaceID: space.id,
          error,
        })
      })
    })

    return {
      async stop() {
        stop.abort()
      },
    }
  }
}
