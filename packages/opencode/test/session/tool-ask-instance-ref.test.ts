import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect/instance-state"

// `Tool.Context.ask` is typed `Effect.Effect<void>` — no requirements — so a tool
// body is entitled to run it standalone. The promise-shaped tools in src/tool do
// exactly that (`await Effect.runPromise(ctx.ask(...))`).
//
// `Effect.runPromise` starts a fresh root fiber whose context is empty, so any
// effect that still reads `InstanceRef` dies with "InstanceRef not provided"
// instead of prompting. That took out the headless workflow contract: the very
// first `finny_workspace_prepare` call errored, leaving every required stage
// missing. These tests pin the bridge as the thing that keeps the declared type
// honest.

const instance = { directory: "/tmp/finny-ask-test" } as any

// Stands in for `permission.ask(...)`, which reaches InstanceRef under the hood.
const readsInstanceRef = Effect.gen(function* () {
  const ctx = yield* InstanceState.context
  return ctx.directory
})

describe("ctx.ask must be self-contained", () => {
  test("a raw InstanceRef-reading effect dies under Effect.runPromise", async () => {
    // The regression: services live on the calling fiber, not in the effect.
    const escaped = await Effect.runPromise(readsInstanceRef).then(
      () => undefined,
      (error) => error,
    )
    expect(String(escaped)).toContain("InstanceRef not provided")
  })

  test("the same effect survives Effect.runPromise once routed through the bridge", async () => {
    const bridged = await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* EffectBridge.make()
        // What session/tools.ts now hands to every tool as `ctx.ask`.
        return run.run(readsInstanceRef)
      }).pipe(Effect.provideService(InstanceRef, instance)),
    )

    // Detached exactly like a promise-shaped tool body does.
    await expect(Effect.runPromise(bridged)).resolves.toBe(instance.directory)
  })

  test("the bridged effect still works for yield* callers", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const run = yield* EffectBridge.make()
        return yield* run.run(readsInstanceRef)
      }).pipe(Effect.provideService(InstanceRef, instance)),
    )
    expect(result).toBe(instance.directory)
  })
})
