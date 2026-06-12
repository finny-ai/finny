import path from "path"
import { Process } from "../util/process"
import { resolveAssetSpec } from "../backtest/asset-spec"

export namespace Validate {
  export type ErrorCode =
    | "SYNTAX_ERROR"
    | "MISSING_STRATEGY_CLASS"
    | "MISSING_INIT_METHOD"
    | "MISSING_ON_TICK_METHOD"
    | "ON_TICK_BAD_PARAMS"
    | "STRICT_SHAPE_REQUIRED"
    | "FORBIDDEN_IMPORT"
    | "DANGEROUS_CALL"
    // Phase 1 AST-based errors
    | "STATE_RESET_IN_ON_TICK"
    | "GAINS_LOSSES_ASYMMETRY"
    | "LOOKAHEAD_BIAS_FLOW"
    | "PRIVATE_BROKER_ACCESS"
    | "FORBIDDEN_REFLECTION"
    // Phase 2 AST-based errors
    | "SAME_BAR_EXECUTION_BIAS"
    | "EQUITY_NEVER_UPDATED"
    | "POSITION_SIZE_UNCAPPED"
    // Phase 1 smoke-test errors
    | "SMOKE_TEST_EXCEPTION"
    | "INVARIANT_BAD_RETURN"
    | "INVARIANT_CONSTANT_TRADES"
    | "INVARIANT_RSI_STUCK"
    | "INVARIANT_STATE_NOT_ACCUMULATING"
    // Phase 2 smoke-test errors
    | "EQUITY_STATIC"
    | "LEVERAGE_VIOLATION"
    // Config cross-reference errors
    | "CONFIG_KEY_UNUSED"
    | "UNSUPPORTED_STRATEGY_CONTRACT"
    // Validator engine errors
    | "VALIDATOR_RUNTIME_ERROR"

  export type WarningCode =
    | "LOOKAHEAD_BIAS"
    | "UNBOUNDED_LIST"
    | "DIVISION_NO_ZERO_CHECK"
    | "NO_RETURN_IN_ON_TICK"
    | "ON_TICK_BAD_RETURN"
    // Phase 1 AST-based warnings
    | "RMS_NOT_STDDEV"
    | "POPULATION_VARIANCE"
    | "MISSING_POSITION_SIZING"
    // Phase 2 AST-based warnings
    | "FRACTIONAL_SHARES_EQUITY"
    | "FUTURES_FRACTIONAL_QTY"
    | "FUTURES_NOTIONAL_SIZING"
    | "CRYPTO_WHOLE_UNIT_QTY"
    | "NEAR_ZERO_DIVISION"
    // Phase 1 smoke-test warnings
    | "INVARIANT_DIRECTIONAL_SANITY"
    // Phase 2 smoke-test warnings
    | "GUARD_NEVER_BINDING"
    // Config warnings
    | "CONFIG_KEY_UNDECLARED"
    | "CONFIG_KEY_VALUE_MATCH"

  export interface Diagnostic {
    code: ErrorCode | WarningCode
    severity: "error" | "warning"
    message: string
    line?: number
    fix?: string
  }

  export interface Result {
    valid: boolean
    errors: Diagnostic[]
    warnings: Diagnostic[]
  }

  export interface Options {
    /** Optional config.json contents (as parsed object or raw string). */
    config?: string | Record<string, unknown>
    /** Skip the behavioral smoke test (useful for fast lint-only checks). */
    skipSmokeTest?: boolean
  }

  const FORBIDDEN_MODULES = [
    "asyncio", "importlib", "io", "os", "pathlib", "pickle", "random", "requests",
    "shutil", "socket", "statistics", "subprocess", "sys", "tempfile", "threading",
  ]
  const DANGEROUS_CALLS = ["exec(", "eval(", "__import__(", "compile(", "open("]

  // Config keys that are legitimately metadata (not expected to appear in strategy code).
  const CONFIG_META_KEYS = new Set([
    // Strategy-level metadata
    "symbol", "interval", "risk", "starting_equity_usd",
    // Platform-level metadata (injected by runner / used by backtest harness, not by strategy code)
    "asset_class", "asset_type", "asset_spec", "assetClass", "venue", "currency",
    "calendar", "tickSize", "lotSize", "multiplier", "feeModel", "marginModel",
    "dataProvider", "productionEligible", "blockingReason", "execution",
    "max_leverage", "initial_margin_pct", "maintenance_margin_pct", "funding_rate_bps",
    "funding_interval_hours", "spread_enabled", "maker_fee_bps", "taker_fee_bps", "commission_per_contract",
    "slippage_bps", "participation_pct", "k_atr", "k_vol",
    "start_date", "end_date", "duration",
    "max_risk_per_trade_pct",
    "_generated",
  ])

  // Known error codes that mirror AST/smoke diagnostic codes. Used to coerce Python-side
  // string codes into our typed unions safely.
  const KNOWN_ERROR_CODES = new Set<ErrorCode>([
    "STATE_RESET_IN_ON_TICK",
    "GAINS_LOSSES_ASYMMETRY",
    "LOOKAHEAD_BIAS_FLOW",
    "PRIVATE_BROKER_ACCESS",
    "FORBIDDEN_REFLECTION",
    "FORBIDDEN_IMPORT",
    "DANGEROUS_CALL",
    "SAME_BAR_EXECUTION_BIAS",
    "EQUITY_NEVER_UPDATED",
    "POSITION_SIZE_UNCAPPED",
    "SMOKE_TEST_EXCEPTION",
    "INVARIANT_BAD_RETURN",
    "INVARIANT_CONSTANT_TRADES",
    "INVARIANT_RSI_STUCK",
    "INVARIANT_STATE_NOT_ACCUMULATING",
    "EQUITY_STATIC",
    "LEVERAGE_VIOLATION",
    "UNSUPPORTED_STRATEGY_CONTRACT",
    "VALIDATOR_RUNTIME_ERROR",
  ])
  const KNOWN_WARNING_CODES = new Set<WarningCode>([
    "RMS_NOT_STDDEV",
    "POPULATION_VARIANCE",
    "MISSING_POSITION_SIZING",
    "FRACTIONAL_SHARES_EQUITY",
    "FUTURES_FRACTIONAL_QTY",
    "FUTURES_NOTIONAL_SIZING",
    "CRYPTO_WHOLE_UNIT_QTY",
    "NEAR_ZERO_DIVISION",
    "DIVISION_NO_ZERO_CHECK",
    "INVARIANT_DIRECTIONAL_SANITY",
    "GUARD_NEVER_BINDING",
  ])

  const RISK_HARD_CODES = new Set<string>([
    "LOOKAHEAD_BIAS_FLOW",
    "SAME_BAR_EXECUTION_BIAS",
    "LEVERAGE_VIOLATION",
    "POSITION_SIZE_UNCAPPED",
    "INVARIANT_RSI_STUCK",
    "INVARIANT_CONSTANT_TRADES",
    "INVARIANT_STATE_NOT_ACCUMULATING",
    "EQUITY_STATIC",
  ])

  function normalize(code: string): string {
    return code.replace(/\t/g, "    ")
  }

  function extractClassBody(code: string, className: string): { body: string; startLine: number } | null {
    const lines = code.split("\n")
    const classPattern = new RegExp(`^class\\s+${className}[\\s(:]`)
    let classStart = -1
    for (let i = 0; i < lines.length; i++) {
      if (classPattern.test(lines[i].trimStart()) && lines[i].trimStart().startsWith("class")) {
        classStart = i
        break
      }
    }
    if (classStart === -1) return null

    const classIndent = lines[classStart].length - lines[classStart].trimStart().length
    const bodyLines: string[] = []
    for (let i = classStart + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === "") {
        bodyLines.push(line)
        continue
      }
      const indent = line.length - line.trimStart().length
      if (indent <= classIndent) break
      bodyLines.push(line)
    }
    return { body: bodyLines.join("\n"), startLine: classStart + 1 }
  }

  function extractMethodBody(classBody: string, methodName: string, classStartLine: number): { body: string; startLine: number } | null {
    const lines = classBody.split("\n")
    const methodPattern = new RegExp(`^\\s+def\\s+${methodName}\\s*\\(`)
    let methodStart = -1
    for (let i = 0; i < lines.length; i++) {
      if (methodPattern.test(lines[i])) {
        methodStart = i
        break
      }
    }
    if (methodStart === -1) return null

    const methodIndent = lines[methodStart].length - lines[methodStart].trimStart().length
    const bodyLines: string[] = []
    for (let i = methodStart + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === "") {
        bodyLines.push(line)
        continue
      }
      const indent = line.length - line.trimStart().length
      if (indent <= methodIndent) break
      bodyLines.push(line)
    }
    return { body: bodyLines.join("\n"), startLine: classStartLine + methodStart + 1 }
  }

  /**
   * Spawn a Python script, feed `code` to stdin, and parse its JSON stdout as diagnostics.
   * Fail closed on subprocess/parse/runtime failures: a broken validator must
   * never make unsafe strategy code appear valid.
   */
  async function runPythonDiagnostic(
    scriptPath: string,
    code: string,
    timeoutMs: number,
    extraArgs: string[] = [],
  ): Promise<Diagnostic[]> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      const proc = Process.spawn(
        ["python3", scriptPath, ...extraArgs],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: timeoutMs },
      )
      proc.stdin!.write(code)
      proc.stdin!.end()

      // Cancellable timeout — clear it on natural exit so we don't SIGKILL
      // a reaped pid (race) or leave a dangling timer.
      let timedOut = false
      const timeout = new Promise<number>((resolve) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true
          try { proc.kill("SIGKILL") } catch {}
          resolve(124)
        }, timeoutMs)
      })

      // Drain BOTH stdout and stderr. Leaving stderr unconsumed can fill the
      // pipe buffer and block the Python subprocess mid-write.
      const stdoutP = new Promise<string>((resolve) => {
        const chunks: Buffer[] = []
        proc.stdout!.on("data", (c: Buffer) => chunks.push(c))
        proc.stdout!.on("end", () => resolve(Buffer.concat(chunks).toString()))
      })
      const stderrP = new Promise<string>((resolve) => {
        const chunks: Buffer[] = []
        proc.stderr!.on("data", (c: Buffer) => chunks.push(c))
        proc.stderr!.on("end", () => resolve(Buffer.concat(chunks).toString()))
      })

      const exitCode = await Promise.race([proc.exited, timeout])
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = undefined }
      const [stdout, stderr] = await Promise.all([stdoutP, stderrP])

      if (exitCode !== 0) {
        const reason = timedOut ? `timed out after ${timeoutMs}ms` : `exited ${exitCode}`
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""
        return [{
          code: "VALIDATOR_RUNTIME_ERROR",
          severity: "error",
          message: `${path.basename(scriptPath)} ${reason}${detail}`,
          fix: "Fix the validator runtime before trusting validation or backtests.",
        }]
      }
      const raw = stdout.trim()
      if (!raw) return []
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch {
        return [{
          code: "VALIDATOR_RUNTIME_ERROR",
          severity: "error",
          message: `${path.basename(scriptPath)} produced non-JSON output`,
          fix: "Fix the validator runtime before trusting validation or backtests.",
        }]
      }
      if (!Array.isArray(parsed)) {
        return [{
          code: "VALIDATOR_RUNTIME_ERROR",
          severity: "error",
          message: `${path.basename(scriptPath)} produced an invalid diagnostics payload`,
          fix: "Fix the validator runtime before trusting validation or backtests.",
        }]
      }

      const diags: Diagnostic[] = []
      for (const d of parsed) {
        if (typeof d !== "object" || d === null) continue
        const code = String((d as any).code ?? "")
        let severity: "error" | "warning" = (d as any).severity === "error" ? "error" : "warning"
        if (RISK_HARD_CODES.has(code)) severity = "error"
        if (severity === "error" && !KNOWN_ERROR_CODES.has(code as ErrorCode)) continue
        if (severity === "warning" && !KNOWN_WARNING_CODES.has(code as WarningCode)) continue
        diags.push({
          code: code as ErrorCode | WarningCode,
          severity,
          message: String((d as any).message ?? ""),
          line: typeof (d as any).line === "number" ? (d as any).line : undefined,
          fix: typeof (d as any).fix === "string" ? (d as any).fix : undefined,
        })
      }
      return diags
    } catch (e: any) {
      return [{
        code: "VALIDATOR_RUNTIME_ERROR",
        severity: "error",
        message: `${path.basename(scriptPath)} failed to run: ${e?.message ?? String(e)}`,
        fix: "Fix the validator runtime before trusting validation or backtests.",
      }]
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  function scriptPath(name: string): string {
    // `import.meta.dir` works in Bun and is the directory of this .ts file.
    // The Python scripts are co-located.
    // Fall back to process.cwd() if import.meta.dir is not available (e.g. Jest).
    // @ts-ignore import.meta
    const dir = typeof import.meta !== "undefined" && (import.meta as any).dir
      ? (import.meta as any).dir
      : path.join(process.cwd(), "packages/opencode/src/algorithm")
    return path.join(dir, name)
  }

  async function checkAST(code: string, symbol?: string): Promise<Diagnostic[]> {
    const args = symbol ? ["--symbol", symbol] : []
    return runPythonDiagnostic(scriptPath("ast_analyzer.py"), code, 5_000, args)
  }

  async function checkSmokeTest(code: string, symbol?: string): Promise<Diagnostic[]> {
    const args = symbol ? ["--symbol", symbol] : []
    return runPythonDiagnostic(scriptPath("smoke_test.py"), code, 15_000, args)
  }

  async function checkSyntax(code: string): Promise<Diagnostic | null> {
    try {
      const proc = Process.spawn(
        ["python3", "-c", "import ast,sys; ast.parse(sys.stdin.read())"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      proc.stdin!.write(code)
      proc.stdin!.end()

      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Promise<string>((resolve) => {
          const chunks: Buffer[] = []
          proc.stderr!.on("data", (chunk: Buffer) => chunks.push(chunk))
          proc.stderr!.on("end", () => resolve(Buffer.concat(chunks).toString()))
        }),
      ])

      if (exitCode !== 0) {
        const lineMatch = stderr.match(/line (\d+)/)
        return {
          code: "SYNTAX_ERROR",
          severity: "error",
          message: stderr.trim() || "Python syntax error",
          line: lineMatch ? parseInt(lineMatch[1]) : undefined,
          fix: "Fix the syntax error in the Python code",
        }
      }
      return null
    } catch (e: any) {
      return {
        code: "VALIDATOR_RUNTIME_ERROR",
        severity: "error",
        message: `Python syntax checker failed to run: ${e?.message ?? String(e)}`,
        fix: "Fix the Python validator runtime before trusting validation or backtests.",
      }
    }
  }

  function checkStructure(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []

    // MISSING_STRATEGY_CLASS
    if (!/class\s+Strategy[\s(:]/.test(code)) {
      diagnostics.push({
        code: "MISSING_STRATEGY_CLASS",
        severity: "error",
        message: "Missing `class Strategy` definition",
        fix: "Add a `class Strategy:` definition to your code",
      })
      return diagnostics // can't check methods without the class
    }

    const classResult = extractClassBody(code, "Strategy")
    if (!classResult) return diagnostics
    const { body: classBody, startLine: classStartLine } = classResult

    function normalizeParamList(raw: string): string[] {
      return raw
        .split(",")
        .map((p) => p.trim().replace(/\s+/g, ""))
        .filter(Boolean)
    }

    const initMatch = classBody.match(/def\s+__init__\s*\(([^)]*)\)/)
    if (!initMatch) {
      diagnostics.push({
        code: "MISSING_INIT_METHOD",
        severity: "error",
        message: "Missing strict constructor `__init__(self, broker, params=None)` in Strategy class",
        fix: "Add `def __init__(self, broker, params=None):` and store only `self.broker = broker` plus your own state.",
      })
    } else {
      const params = normalizeParamList(initMatch[1])
      if (params.length !== 3 || params[0] !== "self" || params[1] !== "broker" || params[2] !== "params=None") {
        diagnostics.push({
          code: "STRICT_SHAPE_REQUIRED",
          severity: "error",
          message: "Strict v2 requires the exact constructor `__init__(self, broker, params=None)`.",
          fix: "Change the constructor to `def __init__(self, broker, params=None):`.",
        })
      }
    }

    const onTickMatch = classBody.match(/def\s+on_tick\s*\(([^)]*)\)/)
    const onBarMatch = classBody.match(/def\s+on_bar\s*\(([^)]*)\)/)
    if (onTickMatch) {
      diagnostics.push({
        code: "STRICT_SHAPE_REQUIRED",
        severity: "error",
        message: "Strict v2 rejects legacy `on_tick`; strategies must implement `on_bar(self, symbol, bar)`.",
        fix: "Replace `on_tick(self, bar)` with `on_bar(self, symbol, bar)` and use `self.broker.buy/sell` order intents.",
      })
    }
    if (!onBarMatch) {
      diagnostics.push({
        code: "MISSING_ON_TICK_METHOD",
        severity: "error",
        message: "Missing strict entry method `on_bar(self, symbol, bar)`.",
        fix: "Add `def on_bar(self, symbol, bar):` to your Strategy class.",
      })
    } else if (onBarMatch) {
      const params = normalizeParamList(onBarMatch[1])
      if (params.length !== 3 || params[0] !== "self" || params[1] !== "symbol" || params[2] !== "bar") {
        const onBarLine = classBody.split("\n").findIndex((l) => /def\s+on_bar/.test(l))
        diagnostics.push({
          code: "ON_TICK_BAD_PARAMS",
          severity: "error",
          message: "Strict v2 requires `on_bar(self, symbol, bar)`.",
          line: onBarLine >= 0 ? classStartLine + onBarLine + 1 : undefined,
          fix: "Change signature to `def on_bar(self, symbol, bar):`",
        })
      }
    }

    return diagnostics
  }

  function checkForbiddenImports(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const lines = code.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith("#")) continue
      for (const mod of FORBIDDEN_MODULES) {
        const importPattern = new RegExp(`^(?:import\\s+${mod}\\b|from\\s+${mod}\\b)`)
        if (importPattern.test(line)) {
          diagnostics.push({
            code: "FORBIDDEN_IMPORT",
            severity: "error",
            message: `Forbidden import: \`${mod}\` is not allowed`,
            line: i + 1,
            fix: `Remove the \`${mod}\` import. Allowed: math, collections, dataclasses, typing, decimal, itertools, functools`,
          })
        }
      }
    }
    return diagnostics
  }

  function checkDangerousCalls(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const lines = code.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith("#")) continue
      for (const call of DANGEROUS_CALLS) {
        if (line.includes(call)) {
          const name = call.replace("(", "")
          diagnostics.push({
            code: "DANGEROUS_CALL",
            severity: "error",
            message: `Dangerous call: \`${name}()\` is not allowed`,
            line: i + 1,
            fix: `Remove the \`${name}()\` call`,
          })
        }
      }
    }
    return diagnostics
  }

  function checkWarnings(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const lines = code.split("\n")
    const normalized = normalize(code)

    // UNBOUNDED_LIST: .append( without deque anywhere
    if (/\.append\s*\(/.test(code) && !/deque/.test(code)) {
      const appendLine = lines.findIndex((l) => /\.append\s*\(/.test(l))
      diagnostics.push({
        code: "UNBOUNDED_LIST",
        severity: "warning",
        message: "List `.append()` found without `deque` — possible memory leak",
        line: appendLine >= 0 ? appendLine + 1 : undefined,
        fix: "Use `collections.deque(maxlen=N)` instead of unbounded lists",
      })
    }

    // DIVISION_NO_ZERO_CHECK moved to ast_analyzer.py: the old line-window
    // regex flagged un-zero-able denominators (e.g. `period + 1`) and missed
    // guards more than 3 lines away, which dead-ended save loops once
    // warnings became blocking.

    // on_tick warnings
    const classResult = extractClassBody(normalized, "Strategy")
    if (classResult) {
      const onTickResult = extractMethodBody(classResult.body, "on_tick", classResult.startLine)
      if (onTickResult) {
        // NO_RETURN_IN_ON_TICK
        if (!/\breturn\b/.test(onTickResult.body)) {
          diagnostics.push({
            code: "NO_RETURN_IN_ON_TICK",
            severity: "warning",
            message: "`on_tick` has no `return` statement",
            line: onTickResult.startLine,
            fix: 'Add `return "HOLD"` (or "BUY"/"SELL") to on_tick',
          })
        }

        // ON_TICK_BAD_RETURN: return values not BUY/SELL/HOLD
        const returnMatches = onTickResult.body.matchAll(/return\s+["'](\w+)["']/g)
        for (const m of returnMatches) {
          if (!["BUY", "SELL", "HOLD"].includes(m[1])) {
            diagnostics.push({
              code: "ON_TICK_BAD_RETURN",
              severity: "warning",
              message: `on_tick returns "${m[1]}" — expected "BUY", "SELL", or "HOLD"`,
              fix: 'Return only "BUY", "SELL", or "HOLD" from on_tick',
            })
            break
          }
        }
      }
    }

    return diagnostics
  }

  /**
   * Flatten a config object to leaf-key names. `symbol`, `interval`, and nested `risk.*`
   * keys are kept; meta-only keys are filtered downstream.
   */
  function flattenConfigKeys(obj: unknown, prefix = ""): string[] {
    const out: string[] = []
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return out
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out.push(...flattenConfigKeys(v, prefix ? `${prefix}.${k}` : k))
      } else {
        out.push(k) // only the leaf name — matches how users reference them in code
      }
    }
    return out
  }

  function parseConfig(config: Options["config"]): Record<string, unknown> | null {
    if (!config) return null
    if (typeof config === "string") {
      try { return JSON.parse(config) as Record<string, unknown> } catch { return null }
    }
    return config as Record<string, unknown>
  }

  function extractSymbol(config: Options["config"]): string | undefined {
    const parsed = parseConfig(config)
    if (!parsed) return undefined
    const sym = parsed.symbol
    return typeof sym === "string" ? sym : undefined
  }

  function flattenConfigLeaves(obj: unknown, prefix = ""): Array<{ key: string; value: unknown }> {
    const out: Array<{ key: string; value: unknown }> = []
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return out
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out.push(...flattenConfigLeaves(v, prefix ? `${prefix}.${k}` : k))
      } else {
        out.push({ key: k, value: v })
      }
    }
    return out
  }

  function checkConfig(code: string, config: Options["config"]): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const parsed = parseConfig(config)
    if (!parsed) return diagnostics
    try {
      const spec = resolveAssetSpec(parsed, typeof parsed.symbol === "string" ? parsed.symbol : "AAPL")
      if (spec.assetClass === "option" && process.env.FINNY_ALLOW_EXPERIMENTAL_OPTIONS !== "1") {
        diagnostics.push({
          code: "UNSUPPORTED_STRATEGY_CONTRACT",
          severity: "error",
          message: `Options are represented but not production-backtest eligible. ${spec.blockingReason}`,
          fix: "Use equity/future/fx/crypto_spot/crypto_perp, or set FINNY_ALLOW_EXPERIMENTAL_OPTIONS=1 only for internal options model work.",
        })
      }
    } catch (e: any) {
      diagnostics.push({
        code: "UNSUPPORTED_STRATEGY_CONTRACT",
        severity: "error",
        message: `Invalid asset specification: ${e?.message ?? String(e)}`,
        fix: "Set a supported asset_class and complete required asset_spec fields.",
      })
    }

    const leaves = flattenConfigLeaves(parsed)
    for (const { key, value } of leaves) {
      if (CONFIG_META_KEYS.has(key)) continue
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      if (new RegExp(`\\b${escaped}\\b`).test(code)) continue

      // Name-match fail. Before flagging a hard error, check if the LITERAL VALUE
      // appears in the strategy code — e.g. config {bollinger_period: 20} used as
      // self.period = 20. That's semantically-used-but-renamed; downgrade to warning.
      //
      // Skip value-match for trivially-common magic numbers (0, 1, 2) and booleans,
      // which match indexing / control-flow literals all over the place.
      let valueLiteral: string | null = null
      if (typeof value === "number") {
        const abs = Math.abs(value)
        const isTrivialInt = Number.isInteger(value) && abs <= 2
        if (!isTrivialInt) valueLiteral = String(value)
      }
      if (valueLiteral !== null) {
        // Word-boundary match so 20 doesn't match 200 / 2000
        const valRe = new RegExp(`(?<![\\w.])${valueLiteral.replace(/[.+]/g, "\\$&")}(?![\\w.])`)
        if (valRe.test(code)) {
          diagnostics.push({
            code: "CONFIG_KEY_VALUE_MATCH",
            severity: "warning",
            message: (
              `Config key \`${key}\` is not referenced by name, but its value (${valueLiteral}) appears ` +
              "as a literal in the code. Rename the attribute to match the config key, or read the value " +
              "from config at init time."
            ),
            fix: `Use \`self.${key}\` in __init__ (load from config) so the key is self-documenting.`,
          })
          continue
        }
      }

      diagnostics.push({
        code: "CONFIG_KEY_UNUSED",
        severity: "warning",
        message: (
          `Config key \`${key}\` is declared but never referenced in the strategy code. ` +
          `Either remove it from config.json or use it (e.g. self.${key} = config["${key}"]).`
        ),
        fix: `Reference \`${key}\` in the Strategy class, or drop the key from config.json.`,
      })
    }
    return diagnostics
  }

  export async function run(code: string, options: Options = {}): Promise<Result> {
    const normalized = normalize(code)

    // Fast structural + security checks. If these fail, skip the heavier checks.
    const syntaxError = await checkSyntax(normalized)
    const structureErrors = checkStructure(normalized)
    const importErrors = checkForbiddenImports(normalized)
    const callErrors = checkDangerousCalls(normalized)
    const regexWarnings = checkWarnings(normalized)
    const configErrors = checkConfig(normalized, options.config)

    const hardFailed =
      syntaxError !== null ||
      structureErrors.length > 0 ||
      importErrors.length > 0 ||
      callErrors.length > 0

    let astDiagnostics: Diagnostic[] = []
    let smokeDiagnostics: Diagnostic[] = []

    if (!hardFailed) {
      const symbol = extractSymbol(options.config)
      astDiagnostics = await checkAST(normalized, symbol)
      if (!options.skipSmokeTest) {
        smokeDiagnostics = await checkSmokeTest(normalized, symbol)
      }
    }

    const allDiagnostics: Diagnostic[] = [
      ...(syntaxError ? [syntaxError] : []),
      ...structureErrors,
      ...importErrors,
      ...callErrors,
      ...configErrors,
      ...regexWarnings,
      ...astDiagnostics,
      ...smokeDiagnostics,
    ]

    const errors = allDiagnostics.filter((d) => d.severity === "error")
    const warnings = allDiagnostics.filter((d) => d.severity === "warning")

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * True when the result carries any risk-flavored warning (lookahead, leverage,
   * position sizing, or invariant-violation smoke diagnostics). Tools that run a
   * backtest can use this to decide whether to prepend a [!] RISK block.
   */
  export function hasRiskWarnings(result: Result): boolean {
    return result.warnings.some(w => RISK_HARD_CODES.has(w.code))
  }

  /** Formatted risk-warning banner — empty string when none. */
  function displayCode(code: ErrorCode | WarningCode): string {
    const aliases: Partial<Record<ErrorCode | WarningCode, string>> = {
      MISSING_ON_TICK_METHOD: "MISSING_ON_BAR_METHOD",
      ON_TICK_BAD_PARAMS: "ON_BAR_BAD_PARAMS",
      STATE_RESET_IN_ON_TICK: "STATE_RESET_IN_ON_BAR",
      NO_RETURN_IN_ON_TICK: "NO_RETURN_IN_ON_BAR",
      ON_TICK_BAD_RETURN: "ON_BAR_BAD_RETURN",
    }
    return aliases[code] ?? code
  }

  export function formatRiskBanner(result: Result): string {
    const risky = [...result.errors, ...result.warnings].filter(w => RISK_HARD_CODES.has(w.code))
    if (risky.length === 0) return ""
    const lines: string[] = [`[!] RISK DIAGNOSTICS (${risky.length}) — backtest results may overstate edge or understate drawdown:`]
    for (const w of risky) {
      const loc = w.line ? ` (line ${w.line})` : ""
      lines.push(`  - ${displayCode(w.code)}${loc}: ${w.message}`)
      if (w.fix) lines.push(`    Fix: ${w.fix}`)
    }
    return lines.join("\n")
  }

  export function format(result: Result): string {
    const parts: string[] = []

    // Risk banner first so it can't be missed.
    const risk = formatRiskBanner(result)
    if (risk) {
      parts.push(risk)
      parts.push("")
    }

    if (result.valid && result.warnings.length === 0) {
      parts.push("Validation passed with no issues.")
      return parts.join("\n")
    }

    if (!result.valid) {
      if (result.errors.length > 0) {
        parts.push(`Validation FAILED — ${result.errors.length} error(s):\n`)
        for (const e of result.errors) {
          const loc = e.line ? ` (line ${e.line})` : ""
          parts.push(`  [ERROR] ${displayCode(e.code)}${loc}: ${e.message}`)
          if (e.fix) parts.push(`          Fix: ${e.fix}`)
        }
      } else {
        parts.push("Validation FAILED — warnings must be cleared before save/backtest.")
      }
    }

    // Separate non-risk warnings to avoid duplicating the risk banner content.
    const nonRiskWarnings = result.warnings.filter(w => !RISK_HARD_CODES.has(w.code))
    if (nonRiskWarnings.length > 0) {
      if (parts.length > 0) parts.push("")
      parts.push(`${nonRiskWarnings.length} warning(s):\n`)
      for (const w of nonRiskWarnings) {
        const loc = w.line ? ` (line ${w.line})` : ""
        parts.push(`  [WARN] ${displayCode(w.code)}${loc}: ${w.message}`)
        if (w.fix) parts.push(`         Fix: ${w.fix}`)
      }
    }

    if (result.valid) {
      parts.push("\nValidation passed (with warnings).")
    }

    return parts.join("\n")
  }
}
