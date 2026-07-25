import { afterEach, describe, expect, test } from "bun:test"
import {
  _resetPythonAvailableCache,
  isPythonAvailable,
  looksLikePythonMissing,
  validationWarningsBlock,
  effectiveSaveConfig,
} from "../../src/tool/algorithm-save"

describe("looksLikePythonMissing", () => {
  test("matches the Windows Microsoft Store launcher stub message", () => {
    expect(
      looksLikePythonMissing(
        "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Manage App Execution Aliases.",
      ),
    ).toBe(true)
  })

  test("matches the Windows cmd.exe 'not recognized' message", () => {
    expect(
      looksLikePythonMissing(
        "'python' is not recognized as an internal or external command, operable program or batch file.",
      ),
    ).toBe(true)
  })

  test("matches POSIX 'command not found' for python and python3", () => {
    expect(looksLikePythonMissing("bash: python: command not found")).toBe(true)
    expect(looksLikePythonMissing("zsh: python3: command not found")).toBe(true)
  })

  test("matches ENOENT spawn failures referencing python", () => {
    expect(looksLikePythonMissing("Error: spawn python3 ENOENT")).toBe(true)
    expect(looksLikePythonMissing("ENOENT: no such file or directory python3")).toBe(true)
  })

  test("matches a SYNTAX_ERROR diagnostic whose message embeds the Windows stub text", () => {
    expect(
      looksLikePythonMissing(
        "SYNTAX_ERROR Python was not found; run without arguments to install from the Microsoft Store",
      ),
    ).toBe(true)
  })

  test("does NOT match a real Python syntax error", () => {
    expect(
      looksLikePythonMissing(
        "SYNTAX_ERROR: invalid syntax at line 12: expected ':' after 'def __init__(self)'",
      ),
    ).toBe(false)
  })

  test("does NOT match an empty or unrelated string", () => {
    expect(looksLikePythonMissing("")).toBe(false)
    expect(looksLikePythonMissing("MISSING_STRATEGY_CLASS: add a `class Strategy:`")).toBe(false)
  })
})

describe("isPythonAvailable", () => {
  afterEach(() => _resetPythonAvailableCache())

  test("returns a boolean result without throwing", async () => {
    // Don't assert true/false — the answer depends on whether the test host
    // has python3 / python on PATH, which varies (Linux/macOS dev boxes have
    // it, minimal Windows CI runners may not). What we DO want to guarantee
    // is that the probe runs to completion and returns a boolean — no
    // unhandled rejection from the spawn, no thrown error.
    expect(typeof (await isPythonAvailable())).toBe("boolean")
  })

  test("caches the result across calls", async () => {
    const a = await isPythonAvailable()
    const b = await isPythonAvailable()
    expect(a).toBe(b)
  })
})

describe("validationWarningsBlock", () => {
  test("blocks advisory warnings until the generated strategy clears them", () => {
    const block = validationWarningsBlock([
      {
        code: "DIVISION_NO_ZERO_CHECK",
        severity: "warning",
        message: "Guard division denominators before dividing.",
      } as any,
    ])

    expect(block?.title).toBe("Failed to save strategy")
    expect(block?.output).toContain("warnings must be cleared before save/backtest")
    expect(block?.output).toContain("DIVISION_NO_ZERO_CHECK")
    expect(block?.output).toContain("Fix: correct every warning")
    expect(block?.metadata.blocked).toBe(true)
    expect(block?.metadata.diagnosticCodes).toEqual(["DIVISION_NO_ZERO_CHECK"])
  })

  test("blocks diagnostics classified as errors", () => {
    const block = validationWarningsBlock([
      {
        code: "SMOKE_TEST_INCONCLUSIVE",
        severity: "error",
        message: "No post-warmup probe was possible.",
      } as any,
    ])

    expect(block?.title).toBe("Failed to save strategy")
    expect(block?.output).toContain("Failed to save strategy:")
    expect(block?.output).toContain("Fix:")
    expect(block?.metadata.blocked).toBe(true)
    expect(block?.metadata.diagnosticCodes).toEqual(["SMOKE_TEST_INCONCLUSIVE"])
  })

  test("allows saves with no validator warnings", () => {
    expect(validationWarningsBlock([])).toBeUndefined()
  })
})

describe("effectiveSaveConfig", () => {
  test("validates version patches with the inherited risk contract that will be persisted", () => {
    const config = effectiveSaveConfig({
      previous: JSON.stringify({
        symbol: "META",
        asset_class: "equity",
        interval: "1h",
        required_history_bars: 30,
        risk_contract: { protective_stop: { mode: "strategy_next_open" } },
        params: { ema_period: 20 },
      }),
      incoming: JSON.stringify({
        symbol: "META",
        asset_class: "equity",
        interval: "1h",
        required_history_bars: 110,
        params: { sma_filter_period: 100 },
      }),
    })

    expect(JSON.parse(config!)).toMatchObject({
      required_history_bars: 110,
      risk_contract: { protective_stop: { mode: "strategy_next_open" } },
      params: { sma_filter_period: 100 },
    })
  })
})
