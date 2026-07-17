export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

export async function runCommand(input: {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  inheritEnv?: boolean
  timeoutMs: number
}): Promise<CommandResult> {
  const started = Date.now()
  const proc = Bun.spawn([input.command, ...input.args], {
    cwd: input.cwd,
    env: input.inheritEnv === false
      ? {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: process.env.LANG ?? "C.UTF-8",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          ...input.env,
        }
      : { ...process.env, ...input.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGTERM")
    setTimeout(() => proc.kill("SIGKILL"), 2_000).unref()
  }, input.timeoutMs)
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)
  return { exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started }
}
