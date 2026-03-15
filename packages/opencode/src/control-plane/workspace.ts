import z from "zod"
import { setTimeout as sleep } from "node:timers/promises"
import { fn } from "@/util/fn"
import { ConvexWorkspaces } from "@/storage/convex/workspaces"
import { Project } from "@/project/project"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Log } from "@/util/log"
import { ProjectID } from "@/project/schema"
import { getAdaptor } from "./adaptors"
import { WorkspaceInfo } from "./types"
import { WorkspaceID } from "./schema"
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
    type: string
    branch?: string | null
    name?: string | null
    directory?: string | null
    extra?: unknown | null
    project_id: string
  }): Info {
    return {
      id: WorkspaceID.make(row.id),
      type: row.type,
      branch: row.branch ?? null,
      name: row.name ?? null,
      directory: row.directory ?? null,
      extra: row.extra ?? null,
      projectID: ProjectID.make(row.project_id),
    }
  }

  const CreateInput = z.object({
    id: WorkspaceID.zod.optional(),
    type: Info.shape.type,
    branch: Info.shape.branch,
    projectID: ProjectID.zod,
    extra: Info.shape.extra,
  })

  export const create = fn(CreateInput, async (input) => {
    const id = WorkspaceID.ascending(input.id)
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
      type: info.type,
      branch: info.branch,
      name: info.name,
      directory: info.directory,
      extra: info.extra,
      project_id: info.projectID,
    })

    await adaptor.create(config)
    return info
  })

  export async function list(project: Project.Info) {
    const rows = await ConvexWorkspaces.listByProject(project.id)
    return rows.map((row: any) => fromRow(row)).sort((a: Info, b: Info) => a.id.localeCompare(b.id))
  }

  export const get = fn(WorkspaceID.zod, async (id) => {
    const row = await ConvexWorkspaces.getById(id)
    if (!row) return
    return fromRow(row)
  })

  export const remove = fn(WorkspaceID.zod, async (id) => {
    const row = await ConvexWorkspaces.getById(id)
    if (row) {
      const info = fromRow(row)
      const adaptor = await getAdaptor(info.type)
      await adaptor.remove(info)
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
    const spaces = (await list(project)).filter((space: Info) => space.type !== "worktree")

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
