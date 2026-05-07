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
    Regenerating: BusEvent.define(
      "algorithm.regenerating",
      z.object({
        sessionID: z.string(),
        algorithmName: z.string(),
        attempt: z.number(),
        maxAttempts: z.number(),
        errorCodes: z.array(z.string()),
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

  export async function getById(algorithmId: string): Promise<Info | null> {
    const result = await ConvexAlgorithms.getById(algorithmId)
    return (result as Info) ?? null
  }

  export async function resolve(identifier: string): Promise<Info | null> {
    return (await get(identifier)) ?? (await getById(identifier))
  }

  export async function getCode(name: string): Promise<string | null> {
    const algo = await get(name)
    return algo?.code ?? null
  }

  export async function remove(algorithmId: string): Promise<void> {
    await ConvexAlgorithms.remove(algorithmId)
    log.info("algorithm removed", { algorithmId })
  }

  // Patch only the `config` JSON string on an existing algorithm. Does NOT
  // bump version — used for chat-driven parameter updates that don't change
  // the strategy code.
  export async function updateConfig(algorithmId: string, config: string): Promise<Info | null> {
    const raw = await ConvexAlgorithms.getById(algorithmId)
    if (!raw) return null
    // Convex documents carry `_id` / `_creationTime` system fields. The upsert
    // mutation has a strict args validator and rejects them, so we explicitly
    // pick only the Info-shaped fields rather than spreading the raw doc.
    const e = raw as any
    const record: Info = {
      algorithmId: e.algorithmId,
      userId: e.userId,
      name: e.name,
      code: e.code,
      language: e.language,
      version: e.version,
      status: e.status,
      description: e.description,
      config,
      backtestCode: e.backtestCode,
      localPath: e.localPath,
      time_created: e.time_created,
      time_updated: Date.now(),
    }
    await ConvexAlgorithms.upsert(record)
    log.info("algorithm config updated", { algorithmId, name: e.name })
    return record
  }
}
