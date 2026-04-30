import { Log } from "../util/log"

export namespace Notify {
  const log = Log.create({ service: "cron.notify" })

  export type NotifyInput = {
    title: string
    body: string
    subtitle?: string
  }

  function escapeAppleScript(s: string) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ").slice(0, 500)
  }

  export async function send(opts: NotifyInput): Promise<void> {
    if (process.platform !== "darwin") {
      log.warn("notify.unsupported", { platform: process.platform })
      return
    }
    const title = escapeAppleScript(opts.title || "Finny")
    const body = escapeAppleScript(opts.body || "")
    const subtitle = opts.subtitle ? ` subtitle "${escapeAppleScript(opts.subtitle)}"` : ""
    const script = `display notification "${body}" with title "${title}"${subtitle}`
    try {
      const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" })
      await proc.exited
      if (proc.exitCode !== 0) {
        const err = await new Response(proc.stderr).text()
        log.error("notify.failed", { err, exitCode: proc.exitCode })
      }
    } catch (err) {
      log.error("notify.threw", { err: String(err) })
    }
  }
}
