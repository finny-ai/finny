import crypto from "crypto"
import { BusEvent } from "../bus/bus-event"
import z from "zod"
import { LocalAlgorithmStore } from "../storage/local/algorithm-store"
import { DeviceProfile } from "../device"
import { Log } from "../util/log"
import { emit } from "../analytics/emit"
import type { BrokerKind } from "@/live/brokers"

const log = Log.create({ service: "algorithm" })
const BrokerKindSchema = z.enum(["alpaca", "binance", "ibkr"])

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
    reasoning: z.string().optional(),
    brokerKind: BrokerKindSchema.optional(),
    targetBrokerage: BrokerKindSchema.optional(),
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

  export type SaveMode = "new" | "version"

  export interface SaveInput {
    name: string
    code: string
    language?: string
    description?: string
    config?: string
    backtestCode?: string
    reasoning?: string
    mission?: string
    prefs?: string
    decisions?: string
    brokerKind?: BrokerKind
    targetBrokerage?: BrokerKind
    saveMode: SaveMode
  }

  export class SaveModeConflictError extends Error {
    readonly kind: "name_taken" | "no_existing_to_version"
    readonly suggested?: string
    constructor(kind: "name_taken" | "no_existing_to_version", message: string, suggested?: string) {
      super(message)
      this.kind = kind
      this.suggested = suggested
    }
  }

  export async function save(input: SaveInput): Promise<Info> {
    const userId = await DeviceProfile.userId()
    const now = Date.now()

    const existing = await LocalAlgorithmStore.getByName(userId, input.name)

    let algorithmId: string
    let time_created: number
    let status: string

    if (input.saveMode === "new") {
      if (existing) {
        throw new SaveModeConflictError(
          "name_taken",
          `Algorithm "${input.name}" already exists. Either choose a different name or use saveMode: "version" to bump it.`,
          deriveSiblingName(input.name),
        )
      }
      algorithmId = crypto.randomUUID()
      time_created = now
      status = "draft"
    } else {
      if (!existing) {
        throw new SaveModeConflictError(
          "no_existing_to_version",
          `Cannot version-bump "${input.name}" — no existing algorithm with that name. Use saveMode: "new".`,
        )
      }
      algorithmId = existing.algorithmId
      time_created = existing.time_created
      status = existing.status ?? "draft"
    }

    const saved = (await LocalAlgorithmStore.insertVersion({
      algorithmId,
      userId,
      name: input.name,
      code: input.code,
      language: input.language ?? "python",
      status,
      description: input.description,
      config: input.config,
      backtestCode: input.backtestCode,
      reasoning: input.reasoning,
      mission: input.mission,
      prefs: input.prefs,
      decisions: input.decisions,
      brokerKind: input.brokerKind ?? (input.saveMode === "version" ? (existing as any)?.brokerKind : undefined),
      targetBrokerage: input.targetBrokerage ?? (input.saveMode === "version" ? (existing as any)?.targetBrokerage : undefined),
      time_created,
      time_updated: now,
    })) as Info
    const record: Info = saved
    log.info("algorithm saved", { algorithmId, name: input.name, version: saved.version, saveMode: input.saveMode })

    emit({
      eventType: "algorithm.saved",
      algorithmId,
      payload: {
        name: input.name,
        code: input.code,
        language: input.language ?? "python",
        version: saved.version,
        status,
        description: input.description,
        config: input.config,
        backtestCode: input.backtestCode,
        reasoning: input.reasoning,
        brokerKind: record.brokerKind,
        saveMode: input.saveMode,
      },
    })

    return record
  }

  export async function list(): Promise<Info[]> {
    const userId = await DeviceProfile.userId()
    const results = await LocalAlgorithmStore.listByUser(userId)
    return results as Info[]
  }

  export async function get(name: string): Promise<Info | null> {
    const userId = await DeviceProfile.userId()
    const result = await LocalAlgorithmStore.getByName(userId, name)
    return (result as Info) ?? null
  }

  export async function getById(algorithmId: string): Promise<Info | null> {
    const result = (await LocalAlgorithmStore.getById(algorithmId)) as Info | null | undefined
    if (!result) return null
    const userId = await DeviceProfile.userId()
    const ownerId = (result as Info & { userId?: string }).userId
    if (ownerId && ownerId !== userId) return null
    return result
  }

  export async function resolve(identifier: string): Promise<Info | null> {
    const looksLikeUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identifier)
    const looksLikeULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(identifier)
    if (looksLikeUUID || looksLikeULID) {
      return (await getById(identifier)) ?? (await get(identifier))
    }
    return (await get(identifier)) ?? (await getById(identifier))
  }

  export async function getCode(name: string): Promise<string | null> {
    const algo = await get(name)
    return algo?.code ?? null
  }

  async function verifyOwnership(algorithmId: string): Promise<boolean> {
    const result = await LocalAlgorithmStore.getById(algorithmId)
    if (!result) return false
    const userId = await DeviceProfile.userId()
    return result.userId === userId
  }

  export async function listVersions(algorithmId: string): Promise<Info[]> {
    if (!(await verifyOwnership(algorithmId))) return []
    const results = await LocalAlgorithmStore.listVersions(algorithmId)
    return (results as Info[]) ?? []
  }

  export async function getVersion(algorithmId: string, version: number): Promise<Info | null> {
    if (!(await verifyOwnership(algorithmId))) return null
    const result = await LocalAlgorithmStore.getByIdAndVersion(algorithmId, version)
    return (result as Info) ?? null
  }

  export async function remove(algorithmId: string): Promise<void> {
    if (!(await verifyOwnership(algorithmId))) return
    await LocalAlgorithmStore.remove(algorithmId)
    log.info("algorithm removed (all versions)", { algorithmId })

    emit({
      eventType: "algorithm.removed",
      algorithmId,
      payload: { algorithmId },
    })
  }

  export async function updateConfig(algorithmId: string, config: string): Promise<Info | null> {
    if (!(await verifyOwnership(algorithmId))) return null
    const result = await LocalAlgorithmStore.patchLatestConfig(algorithmId, config)
    if (!result) return null
    log.info("algorithm config patched", { algorithmId })

    emit({
      eventType: "algorithm.config_patched",
      algorithmId,
      payload: { algorithmId, config },
    })

    return result as Info
  }

  function deriveSiblingName(base: string): string {
    const stripped = base.replace(/-v?\d+$/, "")
    return `${stripped}-2`
  }
}
