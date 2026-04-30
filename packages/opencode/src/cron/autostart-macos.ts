import path from "path"
import os from "os"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"

export namespace Autostart {
  export const LABEL = "com.finny.daemon"

  function plistPath() {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
  }

  function escapeXml(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  }

  function plistContent(programArguments: string[], workingDirectory: string) {
    const out = path.join(Global.Path.log, "daemon.out")
    const err = path.join(Global.Path.log, "daemon.err")
    const args = programArguments.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n")
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(workingDirectory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(out)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(err)}</string>
</dict>
</plist>
`
  }

  export async function isInstalled(): Promise<boolean> {
    return Filesystem.exists(plistPath())
  }

  /**
   * Resolve the right command + working directory to put in the plist.
   *
   * - If `execOverride` is supplied → use it as a single-arg path (caller knows best).
   *   WorkingDirectory falls back to the dir containing exec.
   * - If running as a built `finny` binary (process.execPath ends in /finny) →
   *     [execPath, "serve", "--scheduler"], cwd = exec dir
   * - If running in dev via bun + index.ts (process.execPath = bun, argv[1] = index.ts) →
   *     [bun, "run", "--conditions=browser", index.ts, "serve", "--scheduler"]
   *     cwd = the package dir holding index.ts so bun can resolve node_modules.
   *     The plist has no shell, no PATH — absolute paths are essential.
   */
  function resolveLaunch(execOverride?: string): { programArguments: string[]; workingDirectory: string } {
    if (execOverride) {
      return {
        programArguments: [execOverride, "serve", "--scheduler"],
        workingDirectory: path.dirname(execOverride),
      }
    }

    const exec = process.execPath
    const argv1 = process.argv[1]
    const isBunDev = path.basename(exec) === "bun" && argv1 && argv1.endsWith(".ts")

    if (isBunDev) {
      // index.ts lives in <pkg>/src/index.ts — go up two dirs to <pkg>.
      const pkgDir = path.resolve(path.dirname(argv1), "..")
      return {
        programArguments: [exec, "run", "--conditions=browser", argv1, "serve", "--scheduler"],
        workingDirectory: pkgDir,
      }
    }

    return {
      programArguments: [exec, "serve", "--scheduler"],
      workingDirectory: path.dirname(exec),
    }
  }

  export async function install(
    execOverride?: string,
  ): Promise<{ path: string; programArguments: string[]; workingDirectory: string }> {
    if (process.platform !== "darwin") throw new Error("autostart is macOS-only in v1")
    const target = plistPath()
    await fs.mkdir(path.dirname(target), { recursive: true })
    const { programArguments, workingDirectory } = resolveLaunch(execOverride)
    await fs.writeFile(target, plistContent(programArguments, workingDirectory))
    await Bun.spawn(["launchctl", "unload", target], { stdout: "ignore", stderr: "ignore" }).exited
    const proc = Bun.spawn(["launchctl", "load", target], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    if (proc.exitCode !== 0) {
      const errText = await new Response(proc.stderr).text()
      throw new Error(`launchctl load failed: ${errText}`)
    }
    return { path: target, programArguments, workingDirectory }
  }

  export async function uninstall(): Promise<boolean> {
    const target = plistPath()
    if (!(await Filesystem.exists(target))) return false
    await Bun.spawn(["launchctl", "unload", target], { stdout: "ignore", stderr: "ignore" }).exited
    await fs.rm(target).catch(() => {})
    return true
  }
}
