import crypto from "crypto"
import fs from "fs/promises"
import { rmSync } from "fs"
import path from "path"
import { resolveFinnyHome } from "@finny-ai/core/prefs"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Flock } from "@/util/flock"
import { Process } from "@/util/process"
import { ServerAuth } from "@/server/auth"
import { Log } from "@/util/log"

/**
 * The Finny daemon is just `finny serve --daemon`: a long-lived headless
 * server that owns live-trading runs (and their Python worker subprocesses) so
 * they survive the TUI closing. The TUI auto-spawns one if none is running and
 * connects to it over HTTP+SSE.
 *
 * Discovery is a small JSON file under the Finny home (`daemon/daemon.json`,
 * 0600) holding the daemon's url/port/pid/password. A single-owner Flock guards
 * the spawn so concurrent TUIs don't race to launch duplicates.
 *
 * v1 scope: survive TUI close only. The daemon itself holds run state in memory
 * — surviving a daemon crash/reboot (disk persistence + worker reattach) is a
 * later phase.
 */
export namespace Daemon {
  const log = Log.create({ service: "daemon" })
  const LOCK_KEY = "finny-daemon"

  export interface Info {
    url: string
    hostname: string
    port: number
    pid: number
    /** Basic-auth password the daemon was started with ("" if unsecured). */
    password: string
    startedAt: number
    version: string
  }

  export interface Connection {
    url: string
    headers: Record<string, string> | undefined
    info: Info
  }

  function dir(): string {
    return path.join(resolveFinnyHome().path, "daemon")
  }
  export function infoPath(): string {
    return path.join(dir(), "daemon.json")
  }
  export function logPath(): string {
    return path.join(dir(), "daemon.log")
  }

  export async function readInfo(): Promise<Info | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(infoPath(), "utf8")) as Info
      if (!parsed?.url || !parsed?.pid) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  /** Atomic 0600 write (temp file + rename) so a reader never sees a partial. */
  export async function writeInfo(info: Info): Promise<void> {
    await fs.mkdir(dir(), { recursive: true })
    const tmp = `${infoPath()}.tmp-${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 })
    await fs.rename(tmp, infoPath())
  }

  export async function clearInfo(): Promise<void> {
    await fs.rm(infoPath(), { force: true }).catch(() => {})
  }

  /** Synchronous best-effort cleanup for process-exit handlers. */
  export function clearInfoSync(): void {
    try {
      rmSync(infoPath(), { force: true })
    } catch {
      // best effort
    }
  }

  /** GET /global/health with a short timeout. True only if a daemon answers healthy. */
  export async function probe(info: Pick<Info, "url" | "password">, timeoutMs = 2000): Promise<boolean> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const headers = ServerAuth.headers({ password: info.password }) ?? {}
      const res = await fetch(new URL("/global/health", info.url), { headers, signal: ctrl.signal })
      if (!res.ok) return false
      const body = (await res.json()) as { healthy?: boolean }
      return body?.healthy === true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Resolve the argv to (re)launch this CLI with a subcommand, handling both the
   * compiled `finny` binary and `bun run src/index.ts` dev mode. Mirrors
   * `cron/autostart-macos.ts` `resolveLaunch`.
   */
  function relaunchArgs(subcommand: string[]): { argv: string[]; cwd: string } {
    const exec = process.execPath
    const argv1 = process.argv[1]
    const isBunDev = path.basename(exec) === "bun" && !!argv1 && argv1.endsWith(".ts")
    if (isBunDev) {
      // index.ts lives at <pkg>/src/index.ts; go up one level so node_modules resolves.
      const pkgDir = path.resolve(path.dirname(argv1), "..")
      return { argv: [exec, "run", "--conditions=browser", argv1, ...subcommand], cwd: pkgDir }
    }
    return { argv: [exec, ...subcommand], cwd: path.dirname(exec) }
  }

  function connect(info: Info): Connection {
    return { url: info.url, headers: ServerAuth.headers({ password: info.password }), info }
  }

  /**
   * Ensure a healthy daemon is running and return how to reach it. Reuses an
   * existing daemon when possible; otherwise spawns a detached one under a lock.
   */
  export async function ensure(): Promise<Connection> {
    // Fast path: an already-healthy daemon (auto-spawned or user-run).
    const existing = await readInfo()
    if (existing && (await probe(existing))) {
      log.info("reusing daemon", { url: existing.url, pid: existing.pid })
      return connect(existing)
    }

    // Slow path: single-owner spawn. Double-check inside the lock in case a
    // concurrent TUI just started one.
    return await Flock.withLock(
      LOCK_KEY,
      async () => {
        const again = await readInfo()
        if (again && (await probe(again))) {
          log.info("reusing daemon (post-lock)", { url: again.url, pid: again.pid })
          return connect(again)
        }

        const password = crypto.randomBytes(24).toString("base64url")
        const { argv, cwd } = relaunchArgs(["serve", "--daemon", "--port", "0", "--hostname", "127.0.0.1"])

        await fs.mkdir(dir(), { recursive: true })
        const logFile = await fs.open(logPath(), "a")
        try {
          // The child dups the log fd at spawn time, so closing our handle
          // afterwards is safe. Detached + unref so this TUI can exit freely.
          Process.spawn(argv, {
            cwd,
            detached: true,
            env: { ...process.env, FINNY_SERVER_PASSWORD: password },
            stdin: "ignore",
            stdout: logFile.fd,
            stderr: logFile.fd,
          })
        } finally {
          await logFile.close()
        }
        log.info("spawned daemon", { cwd })

        const info = await waitForHealthy(password)
        return connect(info)
      },
      { staleMs: 60_000, timeoutMs: 30_000 },
    )
  }

  /** Poll the discovery file until the daemon WE just spawned is healthy. */
  async function waitForHealthy(expectedPassword: string, deadlineMs = 20_000): Promise<Info> {
    const start = Date.now()
    let loggedWaiting = false
    while (Date.now() - start < deadlineMs) {
      const info = await readInfo()
      // Match the password so we only trust the daemon we just launched, not a
      // stale file from a dead process.
      if (info && info.password === expectedPassword && (await probe(info, 1000))) return info
      const elapsed = Date.now() - start
      if (!loggedWaiting && elapsed >= 2_000) {
        loggedWaiting = true
        log.info("waiting for daemon health", { elapsed, log: logPath() })
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`Timed out waiting for the Finny daemon to start. See ${logPath()}`)
  }

  /** Build the Info to publish from a freshly-listening server (used by `serve --daemon`). */
  export function infoForServer(server: { url: URL | string; hostname: string; port: number }): Info {
    return {
      url: String(server.url),
      hostname: server.hostname,
      port: server.port,
      pid: process.pid,
      password: process.env["FINNY_SERVER_PASSWORD"] ?? "",
      startedAt: Date.now(),
      version: InstallationVersion,
    }
  }
}
