import { internalMutation } from "./_generated/server"
import { v } from "convex/values"

// Drop undefined keys so we never write explicit `undefined` into optional
// fields (matches the caution used elsewhere in the codebase).
function clean<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

// Fan a batch of consumer telemetry events into the matching tables by `kind`.
// The HTTP action has already validated the envelope (deviceUserId, batch
// shape) and, when configured, the shared ingest secret. Rows are append-only:
// re-sent sessions/messages/parts create new rows and readers take the latest
// by _creationTime. Unknown or malformed entries are skipped, never rejected,
// so one bad event cannot poison a batch.
export const ingestBatch = internalMutation({
  args: {
    deviceUserId: v.string(),
    appVersion: v.optional(v.string()),
    batch: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const deviceUserId = args.deviceUserId
    const appVersion = args.appVersion
    let inserted = 0

    for (const ev of args.batch) {
      if (!ev || typeof ev !== "object") continue
      const now = Date.now()

      switch (ev.kind) {
        case "session":
          if (!ev.id) break
          await ctx.db.insert(
            "telemetrySessions",
            clean({
              sessionId: String(ev.id),
              deviceUserId,
              projectId: ev.project_id,
              directory: ev.directory,
              title: ev.title,
              version: ev.version,
              appVersion,
              data: ev.data,
              timeCreated: ev.time_created ?? now,
              timeUpdated: ev.time_updated,
            }),
          )
          inserted++
          break

        case "message":
          if (!ev.message_id || !ev.session_id) break
          await ctx.db.insert(
            "telemetryMessages",
            clean({
              sessionId: String(ev.session_id),
              messageId: String(ev.message_id),
              deviceUserId,
              role: ev.role,
              provider: ev.provider,
              model: ev.model,
              tokens: ev.tokens,
              cost: ev.cost,
              data: ev.data,
              appVersion,
              timeCreated: ev.time_created ?? now,
            }),
          )
          inserted++
          break

        case "part":
          if (!ev.part_id || !ev.message_id) break
          await ctx.db.insert(
            "telemetryParts",
            clean({
              sessionId: String(ev.session_id ?? ""),
              messageId: String(ev.message_id),
              partId: String(ev.part_id),
              deviceUserId,
              type: ev.type,
              data: ev.data,
              appVersion,
              timeCreated: ev.time_created ?? now,
            }),
          )
          inserted++
          break

        case "event":
          if (!ev.eventType) break
          await ctx.db.insert(
            "telemetryEvents",
            clean({
              eventType: String(ev.eventType),
              eventName: ev.eventName,
              deviceUserId,
              sessionId: ev.session_id,
              projectId: ev.project_id,
              payload: ev.payload,
              source: ev.source,
              appVersion,
              timeCreated: ev.time_created ?? now,
            }),
          )
          inserted++
          break

        case "artifact":
          if (!ev.artifactType || !ev.artifactName || typeof ev.content !== "string") break
          await ctx.db.insert(
            "telemetryArtifacts",
            clean({
              artifactType: String(ev.artifactType),
              artifactName: String(ev.artifactName),
              deviceUserId,
              sessionId: ev.session_id,
              algorithmId: ev.algorithmId,
              algorithmName: ev.algorithmName,
              version: typeof ev.version === "number" ? ev.version : undefined,
              content: ev.content,
              metadata: ev.metadata,
              appVersion,
              timeCreated: ev.time_created ?? now,
            }),
          )
          inserted++
          break

        case "backtest":
          if (!ev.eventType) break
          await ctx.db.insert(
            "telemetryBacktests",
            clean({
              eventType: String(ev.eventType),
              deviceUserId,
              sessionId: ev.session_id,
              algorithmId: ev.algorithmId,
              duration: ev.duration,
              interval: ev.interval,
              capital: ev.capital,
              status: ev.status,
              metrics: ev.metrics,
              payload: ev.payload,
              appVersion,
              timeCreated: ev.time_created ?? now,
            }),
          )
          inserted++
          break

        case "live_order":
          if (!ev.eventType) break
          await ctx.db.insert(
            "telemetryLiveOrders",
            clean({
              eventType: String(ev.eventType),
              deviceUserId,
              sessionId: ev.session_id,
              algorithmId: ev.algorithmId,
              runId: ev.runId,
              orderId: ev.orderId,
              symbol: ev.symbol,
              side: ev.side,
              qty: ev.qty,
              price: ev.price,
              status: ev.status,
              brokerTimestamp: ev.brokerTimestamp,
              brokerage: ev.brokerage,
              mode: ev.mode,
              equity: ev.equity,
              cash: ev.cash,
              logLevel: ev.logLevel,
              logMessage: ev.logMessage,
              payload: ev.payload,
              appVersion,
              timeCreated: ev.time_created ?? now,
            }),
          )
          inserted++
          break

        case "device": {
          // Upsert: one devices row per deviceUserId, refreshed on every boot.
          if (!ev.hostname || !ev.platform) break
          const existing = await ctx.db
            .query("devices")
            .withIndex("by_userId", (q) => q.eq("userId", deviceUserId))
            .first()
          const fields = clean({
            hostname: String(ev.hostname),
            username: String(ev.username ?? ""),
            platform: String(ev.platform),
            arch: String(ev.arch ?? ""),
            installMethod: ev.installMethod,
            version: ev.version ?? appVersion,
            channel: ev.channel,
            time_updated: ev.time_created ?? now,
          })
          if (existing) await ctx.db.patch(existing._id, fields)
          else
            await ctx.db.insert("devices", {
              userId: deviceUserId,
              time_created: ev.time_created ?? now,
              ...fields,
            })
          inserted++
          break
        }

        case "usage": {
          // Upsert by runId: later heartbeats only advance activity fields.
          if (!ev.runId || typeof ev.startedAt !== "number" || typeof ev.lastActiveAt !== "number") break
          const durationMs = Math.max(0, ev.lastActiveAt - ev.startedAt)
          const existing = await ctx.db
            .query("usageSessions")
            .withIndex("by_runId", (q) => q.eq("runId", String(ev.runId)))
            .first()
          if (existing) {
            await ctx.db.patch(
              existing._id,
              clean({ lastActiveAt: ev.lastActiveAt, endedAt: ev.endedAt, durationMs }),
            )
          } else {
            await ctx.db.insert(
              "usageSessions",
              clean({
                runId: String(ev.runId),
                deviceUserId,
                surface: ev.surface,
                appVersion,
                platform: ev.platform,
                installMethod: ev.installMethod,
                startedAt: ev.startedAt,
                lastActiveAt: ev.lastActiveAt,
                endedAt: ev.endedAt,
                durationMs,
              }),
            )
          }
          inserted++
          break
        }

        default:
          break
      }
    }

    return { inserted }
  },
})
