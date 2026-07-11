import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    Project.defaultLayer,
    Session.defaultLayer,
    InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer)),
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("live HttpApi", () => {
  it.live("lists no runs for a fresh project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const res = yield* requestInDirectory("/live", dir)
      expect(res.status).toBe(200)
      expect(yield* res.json).toEqual([])
    }),
  )

  it.live("returns a declared LiveRunNotFoundError for an unknown run", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const res = yield* requestInDirectory("/live/run_does_not_exist", dir)
      expect(res.status).toBe(404)
      expect(yield* res.json).toMatchObject({
        _tag: "LiveRunNotFoundError",
        runID: "run_does_not_exist",
      })
    }),
  )

  it.live("reloads the current algorithm instead of trusting the client payload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const previousBypass = process.env.FINNY_LICENSE_BYPASS
      process.env.FINNY_LICENSE_BYPASS = "1"
      try {
        const res = yield* requestInDirectory("/live/start", dir, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            algorithm: {
              algorithmId: "algo_live_start_failure",
              userId: "user_test",
              name: "Live start failure",
              code: "class Strategy:\n    pass\n",
              language: "python",
              version: 1,
              status: "draft",
              backtestCode: "custom backtest",
              time_created: Date.now(),
              time_updated: Date.now(),
            },
            runId: "strict-run-1",
            symbol: "AAPL",
            interval: "1min",
            accountProviderID: "alpaca-paper-missing",
            brokerKind: "alpaca",
          }),
        })
        expect(res.status).toBe(400)
        expect(yield* res.json).toMatchObject({
          _tag: "LiveRunStartError",
          message: expect.stringContaining("no longer exists"),
        })
      } finally {
        if (previousBypass === undefined) delete process.env.FINNY_LICENSE_BYPASS
        else process.env.FINNY_LICENSE_BYPASS = previousBypass
      }
    }),
  )
})
