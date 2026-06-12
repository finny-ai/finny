import type { Tool } from "./tool"

type ValidationState = {
  failures: number
}

const states = new Map<string, ValidationState>()

const LIMIT = 2

function key(ctx: Tool.Context) {
  return `${ctx.sessionID}:${ctx.messageID}`
}

export function validationFailureCount(ctx: Tool.Context): number {
  return states.get(key(ctx))?.failures ?? 0
}

export function validationRetryLimitReached(ctx: Tool.Context): boolean {
  return validationFailureCount(ctx) >= LIMIT
}

export function recordValidationResult(ctx: Tool.Context, valid: boolean): number {
  const itemKey = key(ctx)
  if (valid) {
    states.delete(itemKey)
    return 0
  }

  const next = (states.get(itemKey)?.failures ?? 0) + 1
  states.set(itemKey, { failures: next })
  return next
}

export function validationRetryLimitMessage(failures = LIMIT): string {
  return [
    `BLOCKED: validation retry limit reached (${failures}/${LIMIT}).`,
    "",
    "Stop this build attempt now. Re-read `algos/_template/README.md` section \"Strategy API & runner shapes\", summarize the exact validator errors/warnings, and do not save, backtest, or keep reshaping this strategy in the current turn.",
  ].join("\n")
}

export function _resetValidationGuardForTests(): void {
  states.clear()
}
