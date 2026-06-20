import { Effect } from "effect"
import type { SessionID } from "./schema"
import type { SessionStatus } from "./status"
import { extractPromptText, runFinnyPreflight } from "./finny-preflight"

export function runSessionPreflight(input: {
  noReply?: boolean
  sessionID: SessionID
  agent: string
  parts: { type: string; text?: string; synthetic?: boolean }[]
  setStatus: (next: SessionStatus.Info) => Effect.Effect<void>
  onError: (error: unknown) => Effect.Effect<void>
}) {
  return Effect.gen(function* () {
    if (input.noReply === true) return undefined
    const preflight = yield* runFinnyPreflight({
      sessionID: input.sessionID,
      agent: input.agent,
      prompt: extractPromptText({ parts: input.parts }),
      setStatus: input.setStatus,
    }).pipe(Effect.tapError(input.onError), Effect.orDie)

    if (!preflight) return undefined
    yield* Effect.logInfo("finny preflight ready", {
      sessionID: input.sessionID,
      workspace: preflight.workspaceSlug,
      envDir: preflight.envDir,
    })
    return preflight
  })
}
