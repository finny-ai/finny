import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { createLocalSdk } from "../local-sdk"
import { FormatError, FormatUnknownError } from "../error"

function formatSdkError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

export const CommandsCommand = effectCmd({
  command: "commands",
  describe: "list available slash and project commands",
  handler: Effect.fn("Cli.commands.list")(function* () {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() => sdk.command.list())
    if (result.error) return yield* fail(formatSdkError(result.error))
    console.log(JSON.stringify(result.data ?? [], null, 2))
  }),
})
