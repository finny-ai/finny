import { expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { Permission } from "@/permission"
import { McpRobinhood } from "@/mcp/robinhood"
import { requestMcpPermission } from "@/session/tools"
import { MessageID, SessionID } from "@/session/schema"
import { testEffect } from "../lib/effect"

const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events)),
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
)
const it = testEffect(env)

const waitForRequest = Effect.gen(function* () {
  const permission = yield* Permission.Service
  return yield* Effect.gen(function* () {
    while (true) {
      const request = (yield* permission.list())[0]
      if (request) return request
      yield* Effect.sleep("10 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.fail(new Error("timed out waiting for Robinhood permission request")),
    }),
  )
})

function request(toolID: string, effectivePermission = Permission.fromConfig({ "*": "allow" })) {
  return Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* requestMcpPermission({
      toolID,
      permission,
      effectivePermission,
      sessionID: SessionID.make("session_robinhood"),
      messageID: MessageID.make("msg_robinhood"),
      callID: "call_robinhood",
    })
  })
}

it.instance(
  "an allowed Robinhood read still waits for explicit approval before invocation",
  () =>
    Effect.gen(function* () {
      let invoked = false
      const fiber = yield* request("robinhood_get_accounts")
        .pipe(Effect.andThen(Effect.sync(() => (invoked = true))))
        .pipe(Effect.forkScoped)

      const pending = yield* waitForRequest
      expect(pending).toMatchObject({
        permission: "robinhood_get_accounts",
        always: [],
        sessionID: SessionID.make("session_robinhood"),
        tool: { messageID: MessageID.make("msg_robinhood"), callID: "call_robinhood" },
      })
      expect(invoked).toBe(false)

      const permission = yield* Permission.Service
      yield* permission.reply({ requestID: pending.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(invoked).toBe(true)
    }),
  { git: true },
)

it.instance(
  "an always reply cannot persist Robinhood approval across reads",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const first = yield* request("robinhood_get_accounts").pipe(Effect.forkScoped)
      const firstPending = yield* waitForRequest
      expect(firstPending.always).toEqual([])
      yield* permission.reply({ requestID: firstPending.id, reply: "always" })
      yield* Fiber.join(first)

      const second = yield* request("robinhood_get_accounts").pipe(Effect.forkScoped)
      const secondPending = yield* waitForRequest
      expect(secondPending.id).not.toBe(firstPending.id)
      expect(secondPending).toMatchObject({
        permission: "robinhood_get_accounts",
        always: [],
      })
      yield* permission.reply({ requestID: secondPending.id, reply: "once" })
      yield* Fiber.join(second)
    }),
  { git: true },
)

it.instance(
  "non-Robinhood MCP asks persist approval against the exact tool ID",
  () =>
    Effect.gen(function* () {
      const fiber = yield* request("docs_search", Permission.fromConfig({ "*": "ask" })).pipe(Effect.forkScoped)
      const pending = yield* waitForRequest
      expect(pending).toMatchObject({
        permission: "docs_search",
        patterns: ["docs_search"],
        always: ["docs_search"],
      })
      const permission = yield* Permission.Service
      yield* permission.reply({ requestID: pending.id, reply: "always" })
      yield* Fiber.join(fiber)

      yield* request("docs_search", Permission.fromConfig({ "*": "ask" }))
      expect(yield* permission.list()).toEqual([])
    }),
  { git: true },
)

it.instance(
  "explicit read denial and every write or unknown Robinhood invocation fail closed",
  () =>
    Effect.gen(function* () {
      const deniedRead = Permission.merge(
        Permission.fromConfig(McpRobinhood.permissionConfig()),
        Permission.fromConfig({ robinhood_get_accounts: "deny" }),
      )
      for (const [toolID, ruleset] of [
        ["robinhood_get_accounts", deniedRead],
        ["robinhood_place_equity_order", Permission.fromConfig({ "*": "allow" })],
        ["robinhood_future_read_tool", Permission.fromConfig({ "*": "allow" })],
      ] as const) {
        let invoked = false
        const exit = yield* request(toolID, ruleset).pipe(
          Effect.andThen(Effect.sync(() => (invoked = true))),
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const denial = Cause.squash(exit.cause)
          expect(denial).toBeInstanceOf(PermissionV1.DeniedError)
          if (denial instanceof PermissionV1.DeniedError && toolID === "robinhood_get_accounts") {
            expect(denial.ruleset).toBe(ruleset)
          }
        }
        expect(invoked).toBe(false)
      }
      expect(yield* (yield* Permission.Service).list()).toEqual([])
    }),
  { git: true },
)
