import type { CliRenderer } from "@opentui/core"
import { ProcessSignal } from "@opencode-ai/core/process-signal"
import { spawn } from "node:child_process"
import { win32DisableProcessedInput, win32FlushInputBuffer } from "../terminal-win32"

const active = new WeakSet<CliRenderer>()

export class ForegroundCommandError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly signal?: NodeJS.Signals,
    readonly cancelled = false,
  ) {
    super(message)
    this.name = "ForegroundCommandError"
  }
}

function safePart(value: string, label: string) {
  if (!value || value.includes("\0")) throw new ForegroundCommandError(`Invalid ${label}`)
  return value
}

/**
 * Give a foreground child temporary ownership of a terminal signal. Finny's
 * telemetry and shutdown listeners consult the shared ownership gate so they
 * do not terminate the parent while the child owns the terminal.
 */
export async function withForegroundSignalGuard<T>(
  signal: NodeJS.Signals,
  run: (interrupted: () => boolean) => Promise<T>,
) {
  return ProcessSignal.withOwnership(signal, run)
}

export function foregroundCommandExitError(code: number | null, signal: NodeJS.Signals | null, interrupted: boolean) {
  const cancelled = interrupted || signal === "SIGINT" || code === 130
  if (code === 0 && !cancelled) return
  return new ForegroundCommandError(
    cancelled
      ? "Interactive command cancelled"
      : `Interactive command exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`,
    code ?? undefined,
    signal ?? undefined,
    cancelled,
  )
}

/**
 * Temporarily gives a foreground child process full ownership of the user's
 * terminal. Output is inherited rather than captured, so interactive secrets
 * never enter the TUI render tree or application logs.
 */
export async function runForegroundInteractiveCommand(input: {
  renderer: CliRenderer
  command: string
  args?: readonly string[]
  cwd?: string
}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ForegroundCommandError("An interactive terminal is required for this command")
  }
  if (active.has(input.renderer)) {
    throw new ForegroundCommandError("Another interactive command is already running")
  }

  const command = safePart(input.command.trim(), "command")
  const args = (input.args ?? []).map((value) => safePart(value, "command argument"))
  active.add(input.renderer)
  let suspended = false

  try {
    await withForegroundSignalGuard("SIGINT", async (interrupted) => {
      try {
        input.renderer.suspend()
        suspended = true
        input.renderer.currentRenderBuffer.clear()

        await new Promise<void>((resolve, reject) => {
          const child = spawn(command, args, {
            cwd: input.cwd,
            stdio: "inherit",
            shell: false,
          })
          child.once("error", reject)
          child.once("exit", (code, signal) => {
            const error = foregroundCommandExitError(code, signal, interrupted())
            if (!error) return resolve()
            reject(error)
          })
        })
      } finally {
        if (suspended && !input.renderer.isDestroyed) {
          input.renderer.currentRenderBuffer.clear()
          input.renderer.resume()
          win32DisableProcessedInput()
          win32FlushInputBuffer()
          input.renderer.requestRender()
        }
      }
    })
  } finally {
    active.delete(input.renderer)
  }
}
