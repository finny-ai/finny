import { createHash } from "node:crypto"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { NamedError } from "@opencode-ai/core/util/error"
import { Database } from "@opencode-ai/core/database/database"
import { GlobalBus } from "@/bus/global"
import type {
  CommandReceiptV1,
  ControlAbortV1,
  ControlCreateSessionV1,
  ControlPromptV1,
} from "@/control/control-contracts"
import { ControlReadService } from "@/control/control-read"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { Cause, Effect, Option, Scope } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ControlCommandNotFoundV1 } from "../groups/control-v1"

type StoredOperation = {
  requestHash: string
  receipt: CommandReceiptV1
}

// V1 deliberately keeps operation receipts in process memory. Bound the map so
// long-running servers retain at most the latest 1,000 control operations.
const operations = new Map<string, StoredOperation>()
const MAX_OPERATIONS = 1_000

function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical)
  if (!input || typeof input !== "object") return input
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>)
      .filter(([name, value]) => name !== "requestHash" && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, canonical(value)]),
  )
}

function stableHash(input: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex")
}

function remember(operationID: string, requestHash: string, receipt: CommandReceiptV1) {
  operations.set(operationID, { requestHash, receipt })
  if (operations.size <= MAX_OPERATIONS) return
  const oldest = operations.keys().next().value
  if (oldest !== undefined) operations.delete(oldest)
}

function replay(operationID: string, requestHash: string): CommandReceiptV1 | undefined {
  const existing = operations.get(operationID)
  if (!existing) return
  if (existing.requestHash !== requestHash) {
    return {
      operationID,
      accepted: false,
      alreadyHandled: true,
      message: `operationID ${operationID} was reused with a different request`,
    }
  }
  return { ...existing.receipt, alreadyHandled: true }
}

function modelParts(model: string) {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) return
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
}

function invalidated(operationID: string) {
  GlobalBus.emit("event", {
    directory: "global",
    payload: { type: "control.invalidated", properties: { domain: "agents", operationID } },
  })
}

export const controlV1Handlers = HttpApiBuilder.group(InstanceHttpApi, "controlV1", (handlers) =>
  Effect.gen(function* () {
    const control = yield* ControlReadService.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    const requireSession = Effect.fn("ControlV1.requireSession")(function* (operationID: string, id: string) {
      const sessionID = SessionID.make(id)
      const found = yield* sessions.get(sessionID).pipe(Effect.option)
      if (Option.isNone(found)) {
        return yield* new ControlCommandNotFoundV1({
          operationID,
          accepted: false,
          sessionID: id,
          message: `Session not found: ${id}`,
        })
      }
      return sessionID
    })

    const createSession = Effect.fn("ControlV1.createSession")(function* ({
      payload,
    }: {
      payload: ControlCreateSessionV1
    }) {
      const hash = stableHash(payload)
      const handled = replay(payload.operationID, hash)
      if (handled) return handled
      const parsedModel = payload.model ? modelParts(payload.model) : undefined
      if (payload.model && !parsedModel) {
        return {
          operationID: payload.operationID,
          accepted: false,
          message: "model must use provider/model format",
        } satisfies CommandReceiptV1
      }
      const created = yield* sessions.create({
        title: payload.title,
        agent: payload.agent,
        metadata: payload.metadata,
        ...(parsedModel
          ? {
              model: {
                providerID: ProviderV2.ID.make(parsedModel.providerID),
                id: ModelV2.ID.make(parsedModel.modelID),
              },
            }
          : {}),
      })
      const receipt: CommandReceiptV1 = {
        operationID: payload.operationID,
        accepted: true,
        sessionID: created.id,
      }
      remember(payload.operationID, hash, receipt)
      invalidated(payload.operationID)
      return receipt
    })

    const prompt = Effect.fn("ControlV1.prompt")(function* ({ payload }: { payload: ControlPromptV1 }) {
      const hash = stableHash(payload)
      const handled = replay(payload.operationID, hash)
      if (handled) return handled
      const sessionID = yield* requireSession(payload.operationID, payload.sessionID)
      const parsedModel = payload.model ? modelParts(payload.model) : undefined
      if (payload.model && !parsedModel) {
        return {
          operationID: payload.operationID,
          accepted: false,
          sessionID: payload.sessionID,
          message: "model must use provider/model format",
        } satisfies CommandReceiptV1
      }

      if (payload.delivery === "queue") {
        const messageID = MessageID.ascending()
        yield* SessionInput.admit(database.db, events, {
          id: SessionMessage.ID.make(messageID),
          sessionID,
          prompt: new Prompt({ text: payload.text, files: [], agents: [] }),
          delivery: "queue",
        })
        yield* sessions.touch(sessionID)
        const receipt: CommandReceiptV1 = {
          operationID: payload.operationID,
          accepted: true,
          sessionID,
          messageID,
        }
        remember(payload.operationID, hash, receipt)
        invalidated(payload.operationID)
        return receipt
      }

      yield* prompts
        .prompt({
          sessionID,
          parts: [{ type: "text", text: payload.text }],
          agent: payload.agent,
          ...(parsedModel
            ? {
                model: {
                  providerID: ProviderV2.ID.make(parsedModel.providerID),
                  modelID: ModelV2.ID.make(parsedModel.modelID),
                },
              }
            : {}),
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logError("control prompt failed", { sessionID, cause })
              yield* events.publish(Session.Event.Error, {
                sessionID,
                error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
              })
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      const receipt: CommandReceiptV1 = {
        operationID: payload.operationID,
        accepted: true,
        sessionID,
      }
      remember(payload.operationID, hash, receipt)
      invalidated(payload.operationID)
      return receipt
    })

    const abort = Effect.fn("ControlV1.abort")(function* ({ payload }: { payload: ControlAbortV1 }) {
      const hash = stableHash(payload)
      const handled = replay(payload.operationID, hash)
      if (handled) return handled
      const sessionID = yield* requireSession(payload.operationID, payload.sessionID)
      yield* prompts.cancel(sessionID)
      const receipt: CommandReceiptV1 = {
        operationID: payload.operationID,
        accepted: true,
        sessionID,
      }
      remember(payload.operationID, hash, receipt)
      invalidated(payload.operationID)
      return receipt
    })

    return handlers
      .handle("overview", () => control.overview())
      .handle("agents", ({ query }) =>
        control.agentCards().pipe(
          Effect.map((cards) => {
            const cursor = query.cursor ? Date.parse(query.cursor) : undefined
            return cards
              .filter((card) => (query.state ? card.status === query.state : true))
              .filter((card) => (cursor === undefined || Number.isNaN(cursor) ? true : card.timeUpdated < cursor))
              .slice(0, query.limit ?? 100)
          }),
        ),
      )
      .handle("crucible", () => control.crucibleCards())
      .handle("crucibleEvents", ({ params, query }) =>
        control
          .crucibleEvents(params.workflowID)
          .pipe(Effect.map((items) => items.filter((item) => item.seq > (query.afterSeq ?? -1)))),
      )
      .handle("campaigns", () => control.campaignCards())
      .handle("createSession", createSession)
      .handle("prompt", prompt)
      .handle("abort", abort)
  }),
)
