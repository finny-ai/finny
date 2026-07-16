import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { runToolHookLifecycle } from "@/session/tool-hook-lifecycle"

const context = {
  tool: "test_tool",
  sessionID: "ses_hook",
  callID: "call_hook",
  messageID: "msg_hook",
  parentSessionID: "ses_parent",
  agent: "researcher",
}

type ObserverOptions = {
  failBefore?: Error
  failAfter?: Error
  failError?: Error
  mutateArgs?: boolean
  mutateOutput?: boolean
}

function mutateObservedOutput(name: string, input: ObserverOptions, output: any) {
  if (name === "tool.execute.before" && input.mutateArgs) output.args = { value: 2 }
  if (name === "tool.execute.after" && input.mutateOutput) output.output = "mutated"
}

function observedFailure(name: string, input: ObserverOptions): Error | undefined {
  return {
    "tool.execute.before": input.failBefore,
    "tool.execute.after": input.failAfter,
    "tool.execute.error": input.failError,
  }[name]
}

function observer(input: ObserverOptions = {}) {
  const calls: Array<{ name: string; hook: any; output: any }> = []
  const plugin = {
    trigger(name: string, hook: any, output: any) {
      calls.push({ name, hook: structuredClone(hook), output })
      mutateObservedOutput(name, input, output)
      const failure = observedFailure(name, input)
      return failure ? Effect.fail(failure) : Effect.succeed(output)
    },
  } as any
  return { calls, plugin }
}

describe("tool hook lifecycle", () => {
  test("runs before and after exactly once and applies argument/output mutation", async () => {
    const { calls, plugin } = observer({ mutateArgs: true, mutateOutput: true })
    const result = await Effect.runPromise(
      runToolHookLifecycle({
        plugin,
        context,
        args: { value: 1 },
        execute: (args) => Effect.succeed({ title: "ok", output: String(args.value), metadata: {} }),
      }),
    )
    expect(result.output.output).toBe("mutated")
    expect(calls.map((call) => call.name)).toEqual(["tool.execute.before", "tool.execute.after"])
    expect(calls[1].hook).toMatchObject({ ...context, args: { value: 2 } })
  })

  test.each([
    ["before", { failBefore: new Error("blocked") }],
    ["execute", {}],
    ["after", { failAfter: new Error("after failed") }],
  ] as const)("notifies error exactly once for %s failures", async (phase, options) => {
    const { calls, plugin } = observer(options)
    const exit = await Effect.runPromiseExit(
      runToolHookLifecycle({
        plugin,
        context,
        args: { value: 1 },
        execute: () =>
          phase === "execute"
            ? Effect.fail(new Error("execution failed"))
            : Effect.succeed({ title: "ok", output: "ok", metadata: {} }),
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const errors = calls.filter((call) => call.name === "tool.execute.error")
    expect(errors).toHaveLength(1)
    expect(errors[0].output.phase).toBe(phase)
    expect(errors[0].hook).toMatchObject({ ...context, args: { value: 1 } })
  })

  test("reports cancellation once with the same identity context", async () => {
    const { calls, plugin } = observer()
    const exit = await Effect.runPromiseExit(
      runToolHookLifecycle({
        plugin,
        context,
        args: {},
        execute: () => Effect.interrupt,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = calls.find((call) => call.name === "tool.execute.error")
    expect(error?.output).toMatchObject({ phase: "execute", interrupted: true })
    expect(error?.hook).toMatchObject(context)
  })

  test("an error-hook failure never replaces the original cause", async () => {
    const original = new Error("original execution failure")
    const { calls, plugin } = observer({ failError: new Error("observer failure") })
    const exit = await Effect.runPromiseExit(
      runToolHookLifecycle({
        plugin,
        context,
        args: {},
        execute: () => Effect.fail(original),
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(original)
    expect(calls.filter((call) => call.name === "tool.execute.error")).toHaveLength(1)
  })
})
