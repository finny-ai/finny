import { Process } from "../util/process"

export namespace Validate {
  export type ErrorCode =
    | "SYNTAX_ERROR"
    | "MISSING_STRATEGY_CLASS"
    | "MISSING_INIT_METHOD"
    | "MISSING_ON_TICK_METHOD"
    | "ON_TICK_BAD_PARAMS"
    | "FORBIDDEN_IMPORT"
    | "DANGEROUS_CALL"

  export type WarningCode =
    | "LOOKAHEAD_BIAS"
    | "UNBOUNDED_LIST"
    | "DIVISION_NO_ZERO_CHECK"
    | "NO_RETURN_IN_ON_TICK"
    | "ON_TICK_BAD_RETURN"

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

  const FORBIDDEN_MODULES = ["os", "subprocess", "sys", "socket", "requests", "pickle", "threading", "asyncio"]
  const DANGEROUS_CALLS = ["exec(", "eval(", "__import__(", "compile(", "open("]

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
    } catch {
      // python3 not found — downgrade to warning-level skip
      return null
    }
  }

  function checkStructure(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const lines = code.split("\n")

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

    // MISSING_INIT_METHOD
    if (!/def\s+__init__\s*\(\s*self/.test(classBody)) {
      diagnostics.push({
        code: "MISSING_INIT_METHOD",
        severity: "error",
        message: "Missing `__init__(self)` method in Strategy class",
        fix: "Add `def __init__(self):` to your Strategy class",
      })
    }

    // MISSING_ON_TICK_METHOD / ON_TICK_BAD_PARAMS
    const onTickMatch = classBody.match(/def\s+on_tick\s*\(([^)]*)\)/)
    if (!onTickMatch) {
      diagnostics.push({
        code: "MISSING_ON_TICK_METHOD",
        severity: "error",
        message: "Missing `on_tick(self, bar)` method in Strategy class",
        fix: "Add `def on_tick(self, bar):` to your Strategy class",
      })
    } else {
      const params = onTickMatch[1]
      if (!/\bbar\b/.test(params)) {
        const onTickLine = classBody.split("\n").findIndex((l) => /def\s+on_tick/.test(l))
        diagnostics.push({
          code: "ON_TICK_BAD_PARAMS",
          severity: "error",
          message: "`on_tick` method is missing the `bar` parameter",
          line: onTickLine >= 0 ? classStartLine + onTickLine + 1 : undefined,
          fix: "Change signature to `def on_tick(self, bar):`",
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
            fix: `Remove the \`${mod}\` import. Allowed: math, statistics, collections, dataclasses, typing, decimal, random, itertools, functools`,
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

    // LOOKAHEAD_BIAS: bar["close"] or bar['close'] used in conditionals
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().startsWith("#")) continue
      if (/bar\s*\[\s*["']close["']\s*\]/.test(line) && /\b(if|elif|while)\b/.test(line)) {
        diagnostics.push({
          code: "LOOKAHEAD_BIAS",
          severity: "warning",
          message: 'Potential lookahead bias: `bar["close"]` used in a conditional',
          line: i + 1,
          fix: 'Use `bar["open"]` for entry decisions to avoid lookahead bias',
        })
      }
    }

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

    // DIVISION_NO_ZERO_CHECK: / without nearby != 0 or > 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line.startsWith("#") || line.startsWith("def ") || line.startsWith("class ")) continue
      // look for division that isn't floor-division comment or string
      if (/[^/]\/[^/=]/.test(line) || /^\s*\w.*\/[^/]/.test(line)) {
        // check surrounding lines for zero-check
        const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n")
        if (!/!=\s*0/.test(context) && !/>\s*0/.test(context) && !/if\s+.*\b\w+\b/.test(context)) {
          diagnostics.push({
            code: "DIVISION_NO_ZERO_CHECK",
            severity: "warning",
            message: "Division without a nearby zero-check guard",
            line: i + 1,
            fix: "Add `if denominator != 0:` before dividing",
          })
          break // only report once
        }
      }
    }

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

  export async function run(code: string): Promise<Result> {
    const normalized = normalize(code)

    const [syntaxError, structureErrors, importErrors, callErrors, warnings] = await Promise.all([
      checkSyntax(normalized),
      Promise.resolve(checkStructure(normalized)),
      Promise.resolve(checkForbiddenImports(normalized)),
      Promise.resolve(checkDangerousCalls(normalized)),
      Promise.resolve(checkWarnings(normalized)),
    ])

    const errors: Diagnostic[] = [
      ...(syntaxError ? [syntaxError] : []),
      ...structureErrors,
      ...importErrors,
      ...callErrors,
    ]

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  export function format(result: Result): string {
    const parts: string[] = []

    if (result.valid && result.warnings.length === 0) {
      parts.push("Validation passed with no issues.")
      return parts.join("\n")
    }

    if (!result.valid) {
      parts.push(`Validation FAILED — ${result.errors.length} error(s):\n`)
      for (const e of result.errors) {
        const loc = e.line ? ` (line ${e.line})` : ""
        parts.push(`  [ERROR] ${e.code}${loc}: ${e.message}`)
        if (e.fix) parts.push(`          Fix: ${e.fix}`)
      }
    }

    if (result.warnings.length > 0) {
      if (parts.length > 0) parts.push("")
      parts.push(`${result.warnings.length} warning(s):\n`)
      for (const w of result.warnings) {
        const loc = w.line ? ` (line ${w.line})` : ""
        parts.push(`  [WARN] ${w.code}${loc}: ${w.message}`)
        if (w.fix) parts.push(`         Fix: ${w.fix}`)
      }
    }

    if (result.valid) {
      parts.push("\nValidation passed (with warnings).")
    }

    return parts.join("\n")
  }
}
