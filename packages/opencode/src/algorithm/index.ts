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

  // Caller picks `new` (sibling lineage, fresh algorithmId, version=1) or
  // `version` (same lineage, version+1). The save() function refuses to
  // guess — see the SaveModeError cases below.
  export type SaveMode = "new" | "version"

  export interface SaveInput {
    name: string
    code: string
    language?: string
    description?: string
    config?: string
    backtestCode?: string
    localPath?: string
    saveMode: SaveMode
  }

  // Tagged errors so the tool layer can format clean messages without
  // string-matching exception text.
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

    const existing = await ConvexAlgorithms.getByName(userId, input.name)

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

    // Version is assigned atomically server-side; insertVersion returns the
    // saved row including the resolved version number. Don't compute it
    // here — concurrent saves on two devices would race otherwise.
    const saved = (await ConvexAlgorithms.insertVersion({
      algorithmId,
      userId,
      name: input.name,
      code: input.code,
      language: input.language ?? "python",
      status,
      description: input.description,
      config: input.config,
      backtestCode: input.backtestCode,
      localPath: input.localPath,
      time_created,
      time_updated: now,
    })) as Info
    const record: Info = saved
    log.info("algorithm saved", { algorithmId, name: input.name, version: saved.version, saveMode: input.saveMode })

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
    // Algorithm IDs are ULIDs (26 chars, Crockford base32). Names are user-chosen
    // and almost never match that shape. Pick the right lookup on the first try
    // instead of two Convex round-trips per resolve call.
    const looksLikeULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(identifier)
    if (looksLikeULID) {
      return (await getById(identifier)) ?? (await get(identifier))
    }
    return (await get(identifier)) ?? (await getById(identifier))
  }

  export async function getCode(name: string): Promise<string | null> {
    const algo = await get(name)
    return algo?.code ?? null
  }

  // All versions for a lineage, newest first. Capped at 100 server-side.
  export async function listVersions(algorithmId: string): Promise<Info[]> {
    const results = await ConvexAlgorithms.listVersions(algorithmId)
    return (results as Info[]) ?? []
  }

  export async function getVersion(algorithmId: string, version: number): Promise<Info | null> {
    const result = await ConvexAlgorithms.getByIdAndVersion(algorithmId, version)
    return (result as Info) ?? null
  }

  // Deletes ALL versions of the lineage.
  export async function remove(algorithmId: string): Promise<void> {
    await ConvexAlgorithms.remove(algorithmId)
    log.info("algorithm removed (all versions)", { algorithmId })
  }

  // In-place patch on the latest version's config string. Does NOT bump
  // version — used for chat-driven param tweaks where the strategy code
  // hasn't changed.
  export async function updateConfig(algorithmId: string, config: string): Promise<Info | null> {
    const result = await ConvexAlgorithms.patchLatestConfig(algorithmId, config)
    if (!result) return null
    log.info("algorithm config patched", { algorithmId })
    return result as Info
  }

  function deriveSiblingName(base: string): string {
    // Strip a trailing `-vN` if present, then append `-2` / `-3` / ... so the
    // suggestion doesn't collide with the conflicting name.
    const stripped = base.replace(/-v?\d+$/, "")
    return `${stripped}-2`
  }
}
