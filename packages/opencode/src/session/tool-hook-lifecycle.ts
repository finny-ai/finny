import type { ToolHookContext, ToolHookErrorPhase } from "@opencode-ai/plugin"
import { Cause, Effect } from "effect"
import { Plugin } from "@/plugin"

export function runToolHookLifecycle<Args, Output, Error, Requirements>(input: {
  plugin: Pick<Plugin.Interface, "trigger">
  context: ToolHookContext
  args: Args
  execute: (args: Args) => Effect.Effect<Output, Error, Requirements>
}): Effect.Effect<{ args: Args; output: Output }, Error, Requirements> {
  let args = input.args
  let phase: ToolHookErrorPhase = "before"
  return Effect.gen(function* () {
    const before = { args }
    yield* input.plugin.trigger("tool.execute.before", input.context, before)
    args = before.args
    phase = "execute"
    const output = yield* input.execute(args)
    phase = "after"
    yield* input.plugin.trigger("tool.execute.after", { ...input.context, args }, output)
    return { args, output }
  }).pipe(
    Effect.catchCause((cause) =>
      input.plugin
        .trigger(
          "tool.execute.error",
          { ...input.context, args },
          { error: Cause.squash(cause), phase, interrupted: Cause.hasInterrupts(cause) },
        )
        .pipe(
          Effect.catchCause(() => Effect.void),
          Effect.andThen(Effect.failCause(cause)),
        ),
    ),
  )
}
