import crypto from "crypto"
import { BusEvent } from "../bus/bus-event"
import z from "zod"
import { ConvexAlgorithms } from "../storage/convex/algorithms"
import { DeviceProfile } from "../device"
import { Log } from "../util/log"

const log = Log.create({ service: "algorithm" })

export namespace Algorithm {
  export const Info = z.object({
    algorithmId: z.string(),
    userId: z.string(),
    name: z.string(),
    code: z.string(),
    language: z.string(),
    version: z.number(),
    status: z.string(),
    description: z.string().optional(),
    config: z.string().optional(),
    backtestCode: z.string().optional(),
    localPath: z.string().optional(),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Saved: BusEvent.define(
      "algorithm.saved",
      z.object({
        algorithmId: z.string(),
        name: z.string(),
        version: z.number(),
      }),
    ),
  }

  export interface SaveInput {
    name: string
    code: string
    language?: string
    description?: string
    config?: string
    backtestCode?: string
    localPath?: string
  }

  export async function save(input: SaveInput): Promise<Info> {
    const userId = await DeviceProfile.userId()
    const now = Date.now()

    const existing = await ConvexAlgorithms.getByName(userId, input.name)
    const version = existing ? existing.version + 1 : 1
    const algorithmId = existing?.algorithmId ?? crypto.randomUUID()

    const record: Info = {
      algorithmId,
      userId,
      name: input.name,
      code: input.code,
      language: input.language ?? "python",
      version,
      status: existing?.status ?? "draft",
      description: input.description,
      config: input.config,
      backtestCode: input.backtestCode,
      localPath: input.localPath,
      time_created: existing?.time_created ?? now,
      time_updated: now,
    }

    await ConvexAlgorithms.upsert(record)
    log.info("algorithm saved", { algorithmId, name: input.name, version })

    return record
  }

  export async function list(): Promise<Info[]> {
    const userId = await DeviceProfile.userId()
    const results = await ConvexAlgorithms.listByUser(userId)
    return results as Info[]
  }

  export async function get(name: string): Promise<Info | null> {
    const userId = await DeviceProfile.userId()
    const result = await ConvexAlgorithms.getByName(userId, name)
    return (result as Info) ?? null
  }

  export async function getCode(name: string): Promise<string | null> {
    const algo = await get(name)
    return algo?.code ?? null
  }

  export async function remove(algorithmId: string): Promise<void> {
    await ConvexAlgorithms.remove(algorithmId)
    log.info("algorithm removed", { algorithmId })
  }
}
