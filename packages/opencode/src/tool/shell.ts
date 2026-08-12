import { Effect, Fiber, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import { Python } from "@/python/env"
import { workspaceEnvDir } from "@/python/session-env"
import { resolveAlpacaMarketDataEnv } from "@/data/alpaca-market-data-env"
import { resolveRegionalMarketDataEnv } from "@/data/regional-market-data-env"
import { resolveBinanceBaseUrl } from "@/data/binance-market-data-env"
import { assertNoWorkerEnvironmentEnumeration, redactSensitiveOutput, workerShellEnv } from "@/security/worker-shell"
import { assertNoRuntimeRequestSpecPath, readRequestSpecForSession } from "@/agent/request-spec"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])
const ALL_WRITE_COMMANDS = new Set([
  "mkdir",
  "touch",
  "rm",
  "chmod",
  "chown",
  "mv",
  "tee",
  "set-content",
  "add-content",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const DESTINATION_WRITE_COMMANDS = new Set(["cp", "copy-item"])
const DOWNLOAD_WRITE_COMMANDS = new Set(["curl", "wget"])
const READ_COMMANDS = new Set(["cat", "get-content", "head", "tail", "wc", "ls"])
const REDIRECT_TARGET_TYPES = ["word", "string", "raw_string", "concatenation", "generic_token"]

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

type WriteTarget = {
  kind: string
  arg: string
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function descendants(node: Node, type: string) {
  return node.descendantsOfType(type).filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function sameOrInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function workspaceDataRoot(slug: string) {
  return path.join(algoDir(slug), "data")
}

function parseIsoDateDay(input: unknown) {
  if (typeof input !== "string") return
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (!match) return
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000
}

function isEquityIntraday5mOverPublicLimit(request: {
  requested_asset_class?: unknown
  requested_interval?: unknown
  requested_start?: unknown
  requested_end?: unknown
}) {
  const asset = String(request.requested_asset_class ?? "").toLowerCase()
  if (asset !== "equity" && asset !== "equities" && asset !== "stock" && asset !== "stocks" && asset !== "etf") {
    return false
  }
  const interval = String(request.requested_interval ?? "").toLowerCase()
  if (interval !== "5m" && interval !== "5min" && interval !== "5 minute" && interval !== "5-minute") return false
  const start = parseIsoDateDay(request.requested_start)
  const end = parseIsoDateDay(request.requested_end)
  return start !== undefined && end !== undefined && end - start > 60
}

function hasEnterpriseIntradaySource(env: NodeJS.ProcessEnv) {
  return Boolean(
    (env.ALPACA_API_KEY_ID && env.ALPACA_API_SECRET_KEY) ||
      env.POLYGON_API_KEY ||
      env.MARKET_DATA_API_KEY ||
      env.BLOOMBERG_API_KEY ||
      env.ORACLE_MARKET_DATA_URL ||
      (env.KITE_API_KEY && env.KITE_ACCESS_TOKEN) ||
      env.SAXO_ACCESS_TOKEN ||
      env.QUESTRADE_ACCESS_TOKEN ||
      (env.FUTU_HOST && env.FUTU_PORT),
  )
}

function workspaceSecRoot(slug: string) {
  return path.join(algoDir(slug), "data", "sec")
}

function workspaceSentimentRoot(slug: string) {
  return path.join(algoDir(slug), "data", "sentiment")
}

function allowedSecRoot(file: string, workspaceSlug: string | null) {
  if (!workspaceSlug) return
  const resolved = path.resolve(file)
  const root = workspaceSecRoot(workspaceSlug)
  if (sameOrInside(root, resolved)) return root
}

function isFlatArtifactTarget(root: string, file: string) {
  const relative = path.relative(path.resolve(root), path.resolve(file))
  if (relative === "") return true
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false
  const parts = relative.split(path.sep).filter(Boolean)
  return parts.length === 1 && parts[0] !== "body" && parts[0] !== "headlines"
}

function allowedSentimentWriteRoot(file: string, workspaceSlug: string | null) {
  if (!workspaceSlug) return
  const resolved = path.resolve(file)
  const root = workspaceSentimentRoot(workspaceSlug)
  if (sameOrInside(root, resolved) && isFlatArtifactTarget(root, resolved)) return root
}

function allowedWorkspaceReadRoot(file: string, workspaceSlug: string | null) {
  if (!workspaceSlug) return
  const resolved = path.resolve(file)
  const root = algoDir(workspaceSlug)
  if (sameOrInside(root, resolved)) return root
}

function allowedDataRoot(file: string, workspaceSlug: string | null) {
  if (!workspaceSlug) return
  const resolved = path.resolve(file)
  const root = workspaceDataRoot(workspaceSlug)
  if (sameOrInside(root, resolved)) return root
}

function isNullSink(target: string) {
  const normalized = unquote(target).trim().toLowerCase()
  return normalized === "/dev/null" || normalized === "nul" || normalized === "$null"
}

function isStdoutSink(target: string) {
  return unquote(target).trim() === "-"
}

function isDotEnv(file: string) {
  return /^\.env(?:$|\.)/.test(path.basename(file))
}

function isHostInterpreterPath(file: string) {
  const base = path.basename(file).toLowerCase()
  if (base === "python" || base === "python3" || base === "python.exe" || base === "python3.exe") return true
  if (/^python3?\d*(\.\d+)?$/.test(base)) return true
  if (file.includes(`${path.sep}homebrew${path.sep}opt${path.sep}python@`)) return true
  if (file.includes(`${path.sep}python-env${path.sep}bin${path.sep}`)) return true
  return false
}

function isRepoLocalBlockedWriteTarget(file: string, worktree: string) {
  const relAlgos = path.relative(path.join(worktree, "algos"), file)
  if (relAlgos !== "" && !relAlgos.startsWith("..") && !path.isAbsolute(relAlgos)) {
    const parts = relAlgos.split(path.sep)
    if (parts[0] === "_template" && parts[1] === "data") return true
    if (parts.length >= 3 && parts[1] === "data" && parts[2] === "news") return true
  }
  const relPackages = path.relative(path.join(worktree, "packages", "opencode", "data"), file)
  if (relPackages !== "" && !relPackages.startsWith("..") && !path.isAbsolute(relPackages)) {
    if (relPackages.startsWith(`news${path.sep}`) || relPackages === "news") return true
  }
  return false
}

function redirectionTargets(root: Node) {
  const targets: WriteTarget[] = []
  for (const node of [...descendants(root, "file_redirect"), ...descendants(root, "redirection")]) {
    for (const type of REDIRECT_TARGET_TYPES) {
      const target = descendants(node, type)[0]?.text.trim()
      if (!target) continue
      targets.push({ kind: "redirection", arg: target })
      break
    }
  }
  return targets
}

function commandWriteArgs(command: Part[], ps: boolean) {
  const tokens = command.map((item) => item.text)
  const raw = tokens[0]
  const cmd = ps ? raw?.toLowerCase() : raw
  if (!cmd) return []

  if (!ps && DOWNLOAD_WRITE_COMMANDS.has(cmd)) return downloadWriteArgs(cmd, tokens.slice(1))

  const args = pathArgs(command, ps)
  if (DESTINATION_WRITE_COMMANDS.has(cmd)) {
    const target = args.at(-1)
    return target ? [{ kind: cmd, arg: target }] : []
  }

  if (!ALL_WRITE_COMMANDS.has(cmd)) return []
  return args.map((arg) => ({ kind: cmd, arg }))
}

function pythonCommandCanWrite(text: string) {
  return (
    /\bopen\s*\([^)]*,\s*["'][^"']*[wax+]/is.test(text) ||
    /\.(?:write_text|write_bytes)\s*\(/i.test(text) ||
    /\b(?:json|pickle)\.dump\s*\(/i.test(text) ||
    /\bto_csv\s*\(/i.test(text)
  )
}

function hasPythonInterpreterWriteCommand(root: Node, ps: boolean) {
  for (const node of commands(root)) {
    const command = parts(node)
    const raw = command[0]?.text
    if (!raw) continue
    const executable = ps ? raw.toLowerCase() : unquote(raw)
    if (isHostInterpreterPath(executable) && pythonCommandCanWrite(node.text)) return true
  }
  return false
}

function downloadWriteArgs(cmd: string, args: string[]) {
  if (cmd === "curl") return curlWriteArgs(args)
  if (cmd === "wget") return wgetWriteArgs(args)
  return []
}

function curlWriteArgs(args: string[]) {
  const out: WriteTarget[] = []
  let remoteName = false
  let outputDir: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-o" || arg === "--output") {
      const target = args[i + 1]
      if (target) {
        out.push({ kind: "curl output", arg: target })
        i++
      }
      continue
    }
    if (arg.startsWith("--output=")) {
      out.push({ kind: "curl output", arg: arg.slice("--output=".length) })
      continue
    }
    if (arg.startsWith("-o") && arg.length > 2) {
      out.push({ kind: "curl output", arg: arg.slice(2) })
      continue
    }
    if (arg === "--output-dir") {
      outputDir = args[i + 1]
      if (outputDir) i++
      continue
    }
    if (arg.startsWith("--output-dir=")) {
      outputDir = arg.slice("--output-dir=".length)
      continue
    }
    if (arg === "-O" || arg === "--remote-name" || (/^-[^-]/.test(arg) && arg.includes("O"))) {
      remoteName = true
    }
  }
  if (remoteName) out.push({ kind: "curl remote-name", arg: outputDir ?? "." })
  return out
}

function wgetWriteArgs(args: string[]) {
  const out: WriteTarget[] = []
  let explicitOutput = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-O" || arg === "--output-document") {
      const target = args[i + 1]
      if (target) {
        explicitOutput = true
        out.push({ kind: "wget output", arg: target })
        i++
      }
      continue
    }
    if (arg.startsWith("--output-document=")) {
      explicitOutput = true
      out.push({ kind: "wget output", arg: arg.slice("--output-document=".length) })
      continue
    }
    if (arg.startsWith("-O") && arg.length > 2) {
      explicitOutput = true
      out.push({ kind: "wget output", arg: arg.slice(2) })
      continue
    }
    if (arg === "-P" || arg === "--directory-prefix") {
      const target = args[i + 1]
      if (target) {
        out.push({ kind: "wget directory-prefix", arg: target })
        i++
      }
      continue
    }
    if (arg.startsWith("--directory-prefix=")) {
      out.push({ kind: "wget directory-prefix", arg: arg.slice("--directory-prefix=".length) })
    }
  }
  if (!explicitOutput) out.push({ kind: "wget output", arg: "." })
  return out
}

function commandReadArgs(command: Part[], ps: boolean) {
  const tokens = command.map((item) => item.text)
  const raw = tokens[0]
  const cmd = ps ? raw?.toLowerCase() : raw
  if (!cmd || !READ_COMMANDS.has(cmd)) return []
  return pathArgs(command, ps).map((arg) => ({ kind: cmd, arg }))
}

function parseDotEnv(text: string) {
  const env: NodeJS.ProcessEnv = {}
  for (const line of text.split(/\r?\n/)) {
    let current = line.trim()
    if (!current || current.startsWith("#")) continue
    if (current.startsWith("export ")) current = current.slice("export ".length).trimStart()

    const eq = current.indexOf("=")
    if (eq <= 0) continue
    const key = current.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = current.slice(eq + 1).trim()
    if (value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'") {
      value = value.slice(1, -1)
    } else if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
    } else {
      value = value.replace(/\s+#.*$/, "")
    }
    env[key] = value
  }
  return env
}

function dotEnvCandidates(cwd: string, instanceDirectory: string) {
  const dirs: string[] = []
  const seen = new Set<string>()
  const add = (dir: string | undefined) => {
    if (!dir) return
    const resolved = path.resolve(dir)
    if (seen.has(resolved)) return
    seen.add(resolved)
    dirs.push(resolved)
  }

  add(instanceDirectory)
  add(cwd)
  return dirs.map((dir) => path.join(dir, ".env"))
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: { command: string; description: string },
) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        description: input.description,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
      description: input.description,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const assertDataExtractorWrites = Effect.fn("ShellTool.assertDataExtractorWrites")(function* (
      ctx: Tool.Context,
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
    ) {
      if (ctx.agent !== "data_extractor") return

      const targets: WriteTarget[] = [...redirectionTargets(root)]
      for (const node of commands(root)) {
        targets.push(...commandWriteArgs(parts(node), ps))
      }
      if (targets.length === 0) return

      const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      const allowedHint = workspace ? workspaceDataRoot(workspace) : "the session workspace data/ directory"
      const instance = yield* InstanceState.context

      for (const target of targets) {
        if (isNullSink(target.arg) || isStdoutSink(target.arg)) continue
        const resolved = yield* argPath(target.arg, cwd, ps, shell)
        if (!resolved) {
          throw new Error(
            `Data Agent bash write blocked: could not resolve ${target.kind} target "${target.arg}". Use an explicit path under an algorithm data/ directory.`,
          )
        }
        if (isRepoLocalBlockedWriteTarget(resolved, instance.worktree)) {
          throw new Error(
            `Data Agent bash write blocked: ${resolved} is a repo-local template/news path. Write outputs under ${allowedHint}.`,
          )
        }
        if (!allowedDataRoot(resolved, workspace)) {
          throw new Error(
            `Data Agent bash write blocked: ${resolved} is outside allowed data roots. Write outputs under ${allowedHint}.`,
          )
        }
      }
    })

    const assertSecAgentWrites = Effect.fn("ShellTool.assertSecAgentWrites")(function* (
      ctx: Tool.Context,
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
    ) {
      if (ctx.agent !== "sec_agent") return

      const targets: WriteTarget[] = [...redirectionTargets(root)]
      for (const node of commands(root)) {
        targets.push(...commandWriteArgs(parts(node), ps))
      }
      if (targets.length === 0) return

      const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      const allowedHint = workspace ? workspaceSecRoot(workspace) : "the session workspace data/sec/ directory"

      for (const target of targets) {
        if (isNullSink(target.arg) || isStdoutSink(target.arg)) continue
        const resolved = yield* argPath(target.arg, cwd, ps, shell)
        if (!resolved) {
          throw new Error(
            `SEC Agent bash write blocked: could not resolve ${target.kind} target "${target.arg}". Use an explicit path under data/sec/.`,
          )
        }
        if (!allowedSecRoot(resolved, workspace)) {
          throw new Error(
            `SEC Agent bash write blocked: ${resolved} is outside allowed SEC roots. Write outputs under ${allowedHint}.`,
          )
        }
      }
    })

    const assertSentimentAgentWrites = Effect.fn("ShellTool.assertSentimentAgentWrites")(function* (
      ctx: Tool.Context,
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
    ) {
      if (ctx.agent !== "sentiment_agent") return

      const targets: WriteTarget[] = [...redirectionTargets(root)]
      for (const node of commands(root)) {
        targets.push(...commandWriteArgs(parts(node), ps))
      }
      if (hasPythonInterpreterWriteCommand(root, ps)) {
        throw new Error(
          "Sentiment Agent bash write blocked: Python interpreter commands can hide file writes inside scripts. Use webfetch/websearch or shell-visible commands with explicit outputs directly under data/sentiment/.",
        )
      }
      if (targets.length === 0) return

      const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      const allowedHint = workspace
        ? workspaceSentimentRoot(workspace)
        : "the session workspace data/sentiment/ directory"

      for (const target of targets) {
        if (isNullSink(target.arg) || isStdoutSink(target.arg)) continue
        const resolved = yield* argPath(target.arg, cwd, ps, shell)
        if (!resolved) {
          throw new Error(
            `Sentiment Agent bash write blocked: could not resolve ${target.kind} target "${target.arg}". Use an explicit path directly under data/sentiment/.`,
          )
        }
        if (!allowedSentimentWriteRoot(resolved, workspace)) {
          throw new Error(
            `Sentiment Agent bash write blocked: ${resolved} is outside allowed flat sentiment roots. Write outputs directly under ${allowedHint}.`,
          )
        }
      }
    })

    const assertSentimentAgentReads = Effect.fn("ShellTool.assertSentimentAgentReads")(function* (
      ctx: Tool.Context,
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
    ) {
      if (ctx.agent !== "sentiment_agent") return

      const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      const allowedHint = workspace ? algoDir(workspace) : "the session workspace directory"

      for (const node of commands(root)) {
        for (const target of commandReadArgs(parts(node), ps)) {
          const resolved = yield* argPath(target.arg, cwd, ps, shell)
          if (!resolved) {
            throw new Error(
              `Sentiment Agent bash read blocked: could not resolve ${target.kind} target "${target.arg}". Use an explicit path under ${allowedHint}.`,
            )
          }
          if (isDotEnv(resolved)) {
            throw new Error(
              `Sentiment Agent bash read blocked: ${target.kind} may not read ${path.basename(resolved)} because env files are not model-visible.`,
            )
          }
          if (isHostInterpreterPath(resolved)) continue
          if (!allowedWorkspaceReadRoot(resolved, workspace)) {
            throw new Error(
              `Sentiment Agent bash read blocked: ${resolved} is outside allowed workspace roots. Use webfetch/websearch for external sources and inspect artifacts under ${workspace ? workspaceSentimentRoot(workspace) : "the session workspace data/sentiment/ directory"}.`,
            )
          }
        }
      }
    })

    const assertDataExtractorReads = Effect.fn("ShellTool.assertDataExtractorReads")(function* (
      ctx: Tool.Context,
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
    ) {
      if (ctx.agent !== "data_extractor") return

      const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      const allowedHint = workspace ? algoDir(workspace) : "the session workspace directory"

      for (const node of commands(root)) {
        for (const target of commandReadArgs(parts(node), ps)) {
          const resolved = yield* argPath(target.arg, cwd, ps, shell)
          if (!resolved) {
            throw new Error(
              `Data Agent bash read blocked: could not resolve ${target.kind} target "${target.arg}". Use an explicit path under ${allowedHint}.`,
            )
          }
          if (isDotEnv(resolved)) {
            throw new Error(
              `Data Agent bash read blocked: ${target.kind} may not read ${path.basename(resolved)} because env files are not model-visible.`,
            )
          }
          if (isHostInterpreterPath(resolved)) continue
          if (!allowedWorkspaceReadRoot(resolved, workspace)) {
            throw new Error(
              `Data Agent bash read blocked: ${resolved} is outside allowed workspace roots. Read repo cookbooks with the read tool and inspect artifacts under ${workspace ? workspaceDataRoot(workspace) : "the session workspace data/ directory"}.`,
            )
          }
        }
      }
    })

    const dataExtractorDataRoot = Effect.fn("ShellTool.dataExtractorDataRoot")(function* (ctx: Tool.Context) {
      if (ctx.agent !== "data_extractor") return
      const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      if (!workspace) return
      return {
        workspace,
        workspacePath: algoDir(workspace),
        dataRoot: workspaceDataRoot(workspace),
      }
    })

    const assertDataExtractorProviderPreflight = Effect.fn("ShellTool.assertDataExtractorProviderPreflight")(function* (
      ctx: Tool.Context,
      command: string,
      env: NodeJS.ProcessEnv,
    ) {
      if (ctx.agent !== "data_extractor") return
      if (/\b(?:uv\s+)?pip(?:3)?\s+install\b|\bpython(?:3(?:\.\d+)?)?\s+-m\s+pip\s+install\b/i.test(command)) {
        throw new Error(
          [
            "Data Agent bash blocked: package installation is disabled during evidence extraction.",
            "Report the missing package as a source/runtime availability issue, try the next configured source, or return a blocker.",
          ].join(" "),
        )
      }
      if (
        !/\byfinance\b|import\s+yfinance|\byf\.|pip(?:3)?\s+install\b.*\byfinance\b|uv\s+pip\s+install\b.*\byfinance\b/i.test(
          command,
        )
      ) {
        return
      }
      const dataRoot = yield* dataExtractorDataRoot(ctx)
      if (!dataRoot) return
      const request = yield* Effect.promise(() => readRequestSpecForSession({ sessionID: ctx.sessionID }))
      if (!request) throw new Error("Data Agent bash blocked: runtime RequestSpec is missing.")
      if (!isEquityIntraday5mOverPublicLimit(request) || hasEnterpriseIntradaySource(env)) return
      throw new Error(
        [
          "Data Agent bash blocked: provider capability preflight forbids yfinance for this request.",
          `requested_symbol=${request.requested_symbol ?? "MISSING"}`,
          `requested_interval=${request.requested_interval ?? "MISSING"}`,
          `requested_asset_class=${request.requested_asset_class ?? "MISSING"}`,
          `requested_start=${request.requested_start ?? "MISSING"}`,
          `requested_end=${request.requested_end ?? "MISSING"}`,
          "Public yfinance cannot provide full-window equity/ETF 5min evidence over more than ~60 calendar days.",
          "Return BLOCKED: requested evidence window unavailable; do not install yfinance or run partial-window diagnostics.",
        ].join(" "),
      )
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      const fileEnv: NodeJS.ProcessEnv = {}
      const runtimeEnv: NodeJS.ProcessEnv = {}
      let request: Record<string, unknown> | undefined
      if (ctx.agent === "data_extractor") {
        const instanceCtx = yield* InstanceState.context
        const dataRoot = yield* dataExtractorDataRoot(ctx)
        if (dataRoot) {
          const text = yield* fs
            .readFileString(path.join(dataRoot.workspacePath, ".env"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          Object.assign(fileEnv, parseDotEnv(text))
        }
        for (const file of dotEnvCandidates(cwd, instanceCtx.directory)) {
          const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
          Object.assign(fileEnv, parseDotEnv(text))
        }
        const baseEnv = { ...fileEnv, ...process.env }
        runtimeEnv.BINANCE_BASE_URL = resolveBinanceBaseUrl(baseEnv)
        if (dataRoot) {
          const requestText = yield* fs
            .readFileString(path.join(dataRoot.workspacePath, "request.json"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          try {
            request = requestText ? JSON.parse(requestText) : undefined
          } catch {
            request = undefined
          }
        }
        if (!baseEnv.ALPACA_API_KEY_ID || !baseEnv.ALPACA_API_SECRET_KEY) {
          const brokerEnv = yield* Effect.promise(() => resolveAlpacaMarketDataEnv(baseEnv))
          if (brokerEnv) Object.assign(runtimeEnv, brokerEnv)
        }
        const requestedSymbol =
          typeof request?.requested_symbol === "string"
            ? request.requested_symbol
            : Array.isArray(request?.requested_symbols) && typeof request.requested_symbols[0] === "string"
              ? request.requested_symbols[0]
              : undefined
        const regionalEnv = yield* Effect.promise(() =>
          resolveRegionalMarketDataEnv({ symbol: requestedSymbol, existing: { ...baseEnv, ...runtimeEnv } }),
        )
        if (regionalEnv) Object.assign(runtimeEnv, regionalEnv)
        if (dataRoot) {
          runtimeEnv.FINNY_STRATEGY_WORKSPACE_NAME = dataRoot.workspace
          runtimeEnv.FINNY_STRATEGY_WORKSPACE_PATH = dataRoot.workspacePath
          runtimeEnv.ALLOWED_DATA_DIR = dataRoot.dataRoot
          runtimeEnv.FINNY_ALLOWED_DATA_DIR = dataRoot.dataRoot
        }
      }

      const workspaceSlug = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
      if (workspaceSlug) {
        const workspacePath = algoDir(workspaceSlug)
        const venvDir = workspaceEnvDir(workspacePath)
        const pyBin = Python.pythonBinForEnvDir(venvDir)
        const venvReady = yield* fs.stat(pyBin).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        )
        if (venvReady) {
          runtimeEnv.FINNY_PYTHON_BIN = pyBin
          runtimeEnv.FINNY_MANAGED_PYTHON = pyBin
          runtimeEnv.VIRTUAL_ENV = venvDir
          const bindir = process.platform === "win32" ? path.join(venvDir, "Scripts") : path.join(venvDir, "bin")
          runtimeEnv.PATH = `${bindir}${path.delimiter}${process.env.PATH ?? ""}`
        } else {
          const managedExists = yield* fs.stat(Python.PATHS.PY_BIN).pipe(
            Effect.map(() => true),
            Effect.catch(() => Effect.succeed(false)),
          )
          if (managedExists) {
            runtimeEnv.FINNY_PYTHON_BIN = Python.PATHS.PY_BIN
            runtimeEnv.FINNY_MANAGED_PYTHON = Python.PATHS.PY_BIN
          }
        }
      } else if (ctx.agent === "data_extractor") {
        const managedExists = yield* fs.stat(Python.PATHS.PY_BIN).pipe(
          Effect.map(() => true),
          Effect.catch(() => Effect.succeed(false)),
        )
        if (managedExists) {
          runtimeEnv.FINNY_PYTHON_BIN = Python.PATHS.PY_BIN
          runtimeEnv.FINNY_MANAGED_PYTHON = Python.PATHS.PY_BIN
        }
      }
      const merged = {
        ...fileEnv,
        ...process.env,
        ...runtimeEnv,
        ...extra.env,
      }
      return workerShellEnv({ agent: ctx.agent, env: merged, request })
    })

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          const pump = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (rawChunk) => {
              const chunk = redactSensitiveOutput({ text: rawChunk, env: input.env })
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          // The process has closed its stdio, but the forked pump may not have
          // consumed every buffered chunk yet. Let it drain before the scope
          // closes and interrupts it, otherwise trailing output is lost.
          if (exit.kind === "exit") yield* Fiber.await(pump)

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              assertNoRuntimeRequestSpecPath({ command: params.command })
              const instanceCtx = yield* InstanceState.context
              const dataRoot = yield* dataExtractorDataRoot(ctx)
              if (ctx.agent === "data_extractor" && !dataRoot) {
                throw new Error(
                  "Data Agent bash blocked: no session workspace is bound. The parent Build/Research session must bootstrap a workspace before data extraction.",
                )
              }
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : (dataRoot?.dataRoot ?? instanceCtx.directory)
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const EVIDENCE_SUBAGENT_MAX_TIMEOUT_MS = 120_000
              if (
                params.timeout !== undefined &&
                params.timeout > EVIDENCE_SUBAGENT_MAX_TIMEOUT_MS &&
                (ctx.agent === "data_extractor" ||
                  ctx.agent === "sec_agent" ||
                  ctx.agent === "sentiment_agent" ||
                  ctx.agent === "news_agent" ||
                  ctx.agent === "researcher")
              ) {
                throw new Error(
                  `Timeout ${params.timeout} ms exceeds the ${EVIDENCE_SUBAGENT_MAX_TIMEOUT_MS / 1000}s cap for evidence subagents. ` +
                    "Split the work into smaller bounded steps (e.g. one bounded sample per month, fewer pages) and never paginate a full window in a single command.",
                )
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              const ps = Shell.ps(shell)
              const env = yield* shellEnv(ctx, cwd)
              assertNoWorkerEnvironmentEnumeration({ agent: ctx.agent, command: params.command })
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  yield* assertDataExtractorWrites(ctx, tree.rootNode, cwd, ps, shell)
                  yield* assertDataExtractorReads(ctx, tree.rootNode, cwd, ps, shell)
                  yield* assertDataExtractorProviderPreflight(ctx, params.command, env)
                  yield* assertSecAgentWrites(ctx, tree.rootNode, cwd, ps, shell)
                  yield* assertSentimentAgentWrites(ctx, tree.rootNode, cwd, ps, shell)
                  yield* assertSentimentAgentReads(ctx, tree.rootNode, cwd, ps, shell)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env,
                  timeout,
                  description: params.description,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
