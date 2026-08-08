import { expect, test } from "bun:test"
import path from "node:path"

test("foreground SIGINT cancels the child interaction without exiting Finny", async () => {
  const proc = Bun.spawn([process.execPath, "run", path.resolve(import.meta.dir, "../fixture/foreground-signal.ts")], {
    cwd: path.resolve(import.meta.dir, "../.."),
    env: {
      ...process.env,
      FINNY_TELEMETRY_DISABLED: "1",
      FINNY_SIGNAL_PROCESS_GROUP: "1",
    },
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  expect(exitCode).toBe(0)
  expect(stderr).toBe("")
  expect(JSON.parse(stdout)).toEqual({ alive: true, interrupted: true })
})
