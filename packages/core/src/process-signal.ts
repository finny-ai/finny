const ownership = new Map<NodeJS.Signals, number>()

export function isOwned(signal: NodeJS.Signals) {
  return (ownership.get(signal) ?? 0) > 0
}

export async function withOwnership<T>(signal: NodeJS.Signals, run: (interrupted: () => boolean) => Promise<T>) {
  ownership.set(signal, (ownership.get(signal) ?? 0) + 1)
  let interrupted = false
  const guard = () => {
    interrupted = true
  }
  process.prependListener(signal, guard)

  try {
    return await run(() => interrupted)
  } finally {
    process.off(signal, guard)
    const remaining = (ownership.get(signal) ?? 1) - 1
    if (remaining > 0) ownership.set(signal, remaining)
    else ownership.delete(signal)
  }
}

export * as ProcessSignal from "./process-signal"
