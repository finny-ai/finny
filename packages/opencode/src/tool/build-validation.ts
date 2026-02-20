import { Tool } from "./tool"
import z from "zod"
import fs from "fs"
import path from "path"
import { Instance } from "../project/instance"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"
const STRATEGY_DIRS = ["strategies", "packages/opencode/strategies"]

async function findStrategyFile(name: string): Promise<string | null> {
  for (const dir of STRATEGY_DIRS) {
    const fullPath = path.join(Instance.directory, dir, `${name}.py`)
    const exists = await fs.promises
      .access(fullPath)
      .then(() => true)
      .catch(() => false)
    if (exists) return fullPath
  }
  return null
}

// Common Python strategy errors and their fixes
const ERROR_SUGGESTIONS: Array<{
  pattern: RegExp
  suggestion: string
}> = [
  {
    pattern: /NameError.*'(\w+)' is not defined/i,
    suggestion: "Make sure the variable or function is defined before use. Check for typos in variable names.",
  },
  {
    pattern: /IndentationError/i,
    suggestion: "Python uses indentation for code blocks. Use consistent 4-space indentation.",
  },
  {
    pattern: /SyntaxError.*invalid syntax/i,
    suggestion: "Check for missing colons (:) after if/for/def/class statements, unmatched parentheses, or missing commas.",
  },
  {
    pattern: /TypeError.*'NoneType'/i,
    suggestion: "A function returned None when you expected a value. Check return statements and None checks.",
  },
  {
    pattern: /KeyError.*'(\w+)'/i,
    suggestion: "The key doesn't exist in the dictionary. Use .get() with a default value or check if key exists first.",
  },
  {
    pattern: /IndexError.*out of range/i,
    suggestion: "List index is out of bounds. Check list length before accessing indices. Use len(list) to verify.",
  },
  {
    pattern: /ZeroDivisionError/i,
    suggestion: "Division by zero. Add a check: `if denominator != 0:` before dividing.",
  },
  {
    pattern: /AttributeError.*has no attribute '(\w+)'/i,
    suggestion: "The object doesn't have this attribute. Check spelling or verify the object type.",
  },
  {
    pattern: /class Strategy.*not found/i,
    suggestion: "Your strategy file must define a class named 'Strategy' with an on_tick method.",
  },
  {
    pattern: /on_tick.*not found/i,
    suggestion: "The Strategy class must have an on_tick(self, bar: dict) -> str method that returns 'BUY', 'SELL', or 'HOLD'.",
  },
  {
    pattern: /import.*not allowed/i,
    suggestion: "Only safe imports are allowed: math, statistics, collections, dataclasses, typing, decimal, random, itertools, functools.",
  },
]

function getSuggestion(error: string): string | null {
  for (const { pattern, suggestion } of ERROR_SUGGESTIONS) {
    if (pattern.test(error)) {
      return suggestion
    }
  }
  return null
}

export const ValidateStrategyTool = Tool.define("validate_strategy", async () => {
  return {
    description:
      "Validate a trading strategy without deploying it. Checks Python syntax, required class structure, " +
      "and runs the simulator's validation endpoint. Use this before deploying to catch errors early. " +
      "Accepts either a strategy name (reads from file) or inline code.",
    parameters: z.object({
      strategy_name: z
        .string()
        .optional()
        .describe("Name of the strategy file to validate (without .py extension)"),
      code: z
        .string()
        .optional()
        .describe("Inline Python code to validate (alternative to strategy_name)"),
    }),
    async execute(params, ctx): Promise<{title: string; output: string; metadata: Record<string, any>}> {
      try {
        let code: string
        let source: string

        if (params.code) {
          code = params.code
          source = "inline code"
        } else if (params.strategy_name) {
          const filePath = await findStrategyFile(params.strategy_name)
          if (!filePath) {
            return {
              title: "Validation Failed",
              output: `Strategy file "${params.strategy_name}.py" not found.

**Search paths:**
${STRATEGY_DIRS.map((d) => `- ${d}/`).join("\n")}

Use list_strategies to see available strategies.`,
              metadata: { valid: false, error: "file_not_found" },
            }
          }
          code = await fs.promises.readFile(filePath, "utf-8")
          source = filePath
        } else {
          return {
            title: "Validation Failed",
            output: "Please provide either strategy_name or code parameter.",
            metadata: { valid: false, error: "missing_parameter" },
          }
        }

        // Basic local checks first
        const localErrors: string[] = []

        // Check for Strategy class
        if (!/class\s+Strategy\s*[:(]/.test(code)) {
          localErrors.push("Missing 'class Strategy' definition")
        }

        // Check for on_tick method
        if (!/def\s+on_tick\s*\(\s*self/.test(code)) {
          localErrors.push("Missing 'on_tick(self, bar)' method in Strategy class")
        }

        // Check for forbidden imports
        const forbiddenImports = ["os", "subprocess", "sys", "socket", "requests", "pickle", "threading", "asyncio"]
        for (const imp of forbiddenImports) {
          const importPattern = new RegExp(`^\\s*(import|from)\\s+${imp}\\b`, "m")
          if (importPattern.test(code)) {
            localErrors.push(`Forbidden import: ${imp}`)
          }
        }

        // Call simulator validation endpoint
        let simulatorResult: any = null
        let simulatorError: string | null = null

        try {
          const response = await fetch(`${SIMULATOR_URL}/validate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
            signal: ctx.abort,
          })

          if (response.ok) {
            simulatorResult = await response.json()
          } else {
            const errorData = await response.json().catch(() => ({}))
            simulatorError = errorData.error || errorData.message || `HTTP ${response.status}`
          }
        } catch (error: any) {
          if (error.name === "AbortError") throw error
          simulatorError = `Simulator unavailable: ${error.message}. Make sure the simulator is running.`
        }

        // Build result
        const allErrors: string[] = [...localErrors]
        if (simulatorResult && !simulatorResult.valid) {
          allErrors.push(simulatorResult.error || "Simulator validation failed")
        }
        if (simulatorError) {
          allErrors.push(simulatorError)
        }

        const isValid = allErrors.length === 0 || (simulatorResult?.valid === true && localErrors.length === 0)

        if (isValid) {
          return {
            title: "Validation Passed ✅",
            output: `Strategy validation successful!

**Source:** ${source}
**Lines:** ${code.split("\n").length}
**Status:** ✅ Ready to deploy

**Next steps:**
- Use \`deploy_strategy\` to deploy to the trading arena
- Use \`/deploy\` command in the TUI for interactive deployment`,
            metadata: {
              valid: true,
              source,
              lines: code.split("\n").length,
              simulatorResult,
            },
          }
        }

        // Build error report
        const lines: string[] = []
        lines.push("# Validation Failed ❌")
        lines.push("")
        lines.push(`**Source:** ${source}`)
        lines.push("")
        lines.push("## Errors")
        lines.push("")

        for (const error of allErrors) {
          lines.push(`- ❌ ${error}`)
          const suggestion = getSuggestion(error)
          if (suggestion) {
            lines.push(`  💡 *${suggestion}*`)
          }
        }

        lines.push("")
        lines.push("## Required Strategy Structure")
        lines.push("")
        lines.push("```python")
        lines.push("class Strategy:")
        lines.push("    def __init__(self):")
        lines.push("        # Initialize state here")
        lines.push("        pass")
        lines.push("")
        lines.push('    def on_tick(self, bar: dict) -> str:')
        lines.push("        # bar = {'symbol', 'open', 'high', 'low', 'close', 'volume', 'timestamp'}")
        lines.push('        # Return "BUY", "SELL", or "HOLD"')
        lines.push('        return "HOLD"')
        lines.push("```")
        lines.push("")
        lines.push("**Allowed imports:** math, statistics, collections, dataclasses, typing, decimal, random, itertools, functools")

        return {
          title: "Validation Failed ❌",
          output: lines.join("\n"),
          metadata: {
            valid: false,
            errors: allErrors,
            source,
            simulatorResult,
          },
        }
      } catch (error: any) {
        if (error.name === "AbortError") throw error
        return {
          title: "Validation Error",
          output: `Validation failed with error: ${error.message}`,
          metadata: { valid: false, error: error.message },
        }
      }
    },
  }
})

export const CheckStrategySyntaxTool = Tool.define("check_strategy_syntax", async () => {
  return {
    description:
      "Quick syntax check for Python strategy code. Returns any Python syntax errors with line numbers. " +
      "Faster than full validation - use this while iterating on code.",
    parameters: z.object({
      code: z.string().describe("Python code to check for syntax errors"),
    }),
    async execute(params, ctx): Promise<{title: string; output: string; metadata: Record<string, any>}> {
      try {
        // Use Python to check syntax
        const { spawn } = await import("child_process")

        return new Promise((resolve) => {
          const python = spawn("python3", ["-c", `
import ast
import sys
import json

code = '''${params.code.replace(/'/g, "\\'")}'''

try:
    ast.parse(code)
    print(json.dumps({"valid": True}))
except SyntaxError as e:
    print(json.dumps({
        "valid": False,
        "error": str(e.msg),
        "line": e.lineno,
        "column": e.offset,
        "text": e.text.strip() if e.text else None
    }))
`])

          let stdout = ""
          let stderr = ""

          python.stdout.on("data", (data) => {
            stdout += data.toString()
          })

          python.stderr.on("data", (data) => {
            stderr += data.toString()
          })

          python.on("close", (exitCode) => {
            try {
              const result = JSON.parse(stdout.trim())

              if (result.valid) {
                resolve({
                  title: "Syntax Check Passed ✅",
                  output: `Python syntax is valid.

**Lines:** ${params.code.split("\n").length}

**Note:** This only checks syntax. Use \`validate_strategy\` for full validation including:
- Strategy class structure
- Required methods
- Forbidden imports
- Simulator compatibility`,
                  metadata: { valid: true, lines: params.code.split("\n").length },
                })
              } else {
                const suggestion = getSuggestion(result.error) || "Check the syntax at the indicated line."

                resolve({
                  title: "Syntax Error ❌",
                  output: `Python syntax error found:

**Error:** ${result.error}
**Line:** ${result.line}${result.column ? ` (column ${result.column})` : ""}
${result.text ? `**Code:** \`${result.text}\`` : ""}

💡 *${suggestion}*`,
                  metadata: {
                    valid: false,
                    error: result.error,
                    line: result.line,
                    column: result.column,
                    text: result.text,
                  },
                })
              }
            } catch (e) {
              resolve({
                title: "Syntax Check Error",
                output: `Failed to parse Python output: ${stderr || stdout || "Unknown error"}`,
                metadata: { valid: false, error: stderr || stdout },
              })
            }
          })

          python.on("error", (err) => {
            resolve({
              title: "Syntax Check Error",
              output: `Python not available: ${err.message}. Make sure python3 is installed.`,
              metadata: { valid: false, error: err.message },
            })
          })
        })
      } catch (error: any) {
        return {
          title: "Syntax Check Error",
          output: `Syntax check failed: ${error.message}`,
          metadata: { valid: false, error: error.message },
        }
      }
    },
  }
})
