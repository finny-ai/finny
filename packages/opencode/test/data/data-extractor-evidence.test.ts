import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Mission } from "../../src/algorithm/mission"
import { bindSessionWorkspace, clearSessionWorkspace } from "@finny-ai/core/algo"
import {
  REQUIRED_DIGEST_FIELDS,
  requireVerifiedDataExtractorEvidenceForSession,
  validateDataExtractorTaskText,
  validateExistingDataExtractorEvidence,
} from "../../src/data/data-extractor-evidence"
import { classifyText, gradeSessions } from "../../script/phoenix-trace-grader"

const questionnaire = () =>
  Mission.CORE8_IDS.map((id) => ({
    id,
    question: `Question for ${id}?`,
    answer: "answer",
    status: "answered" as const,
  }))

describe("Mission.renderV3", () => {
  test("renders valid schema_version 3 mission with body preferences after frontmatter", () => {
    const mission = Mission.renderV3({
      name: "spy-5m-momentum",
      hypothesis: "Momentum after consolidation: edge comes from continuation, not mean reversion.",
      scope: { asset_class: "equities", universe: ["SPY"], horizon: "intraday" },
      strategy: {
        bar_interval: "5min",
        type: "momentum",
        direction: "long",
        entry_signal: "Breakout above prior range with volume confirmation",
        risk_profile: "moderate",
        max_drawdown_pct: "15",
        backtest_window: "3mo",
        success_metric: "Sharpe above 0.8 with max drawdown under 15%",
      },
      exit_conditions: "- Exit on momentum failure\n- Stop: 2%",
      questionnaire: questionnaire(),
      userPreferences: "- Capital: $10,000\n- Data depth: Alpaca primary, yfinance fallback",
    })

    expect(Mission.validate(mission)).toEqual([])
    expect(mission).toContain("schema_version: 3")
    expect(mission).toContain("status: research")
    expect(mission).toContain("asset_class: equities")
    expect(mission).toContain("horizon: intraday")
    expect(mission).toContain("direction: long")
    const bodyStart = mission.indexOf("\n# spy-5m-momentum")
    const prefsStart = mission.indexOf("## User Preferences")
    expect(bodyStart).toBeGreaterThan(mission.indexOf("---", 4))
    expect(prefsStart).toBeGreaterThan(bodyStart)
  })

  test("uses block scalars for colon-heavy prose", () => {
    const mission = Mission.renderV3({
      name: "btc-mean-reversion",
      hypothesis: "Risk note: max drawdown target 15% with stop: 2% and take profit: 4%",
      scope: { asset_class: "crypto", universe: ["BTC"], horizon: "weeks" },
      strategy: {
        bar_interval: "1h",
        type: "mean-reversion",
        direction: "both",
        entry_signal: "RSI: oversold with filter",
        risk_profile: "moderate",
        max_drawdown_pct: "15",
        backtest_window: "6mo",
        success_metric: "Sharpe: > 0.8",
      },
      exit_conditions: "Exit: RSI normalization",
      questionnaire: questionnaire(),
    })
    expect(Mission.validate(mission)).toEqual([])
    expect(mission).toContain('"Sharpe: > 0.8"')
  })
})

describe("validateDataExtractorTaskText", () => {
  test("session build gate blocks when no workspace is bound", async () => {
    const result = await requireVerifiedDataExtractorEvidenceForSession("ses_no_workspace")
    expect(result.ok).toBe(false)
    expect(result.text).toContain("BLOCKED: evidence required before strategy build")
    expect(result.text).toContain("no session workspace is bound")
  })

  test("session build gate blocks when workspace has no verified evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-gate-"))
    process.env.XDG_DATA_HOME = root
    await bindSessionWorkspace("ses_no_evidence", "sol-1d-strategy")
    try {
      const result = await requireVerifiedDataExtractorEvidenceForSession("ses_no_evidence")
      expect(result.ok).toBe(false)
      expect(result.workspaceSlug).toBe("sol-1d-strategy")
      expect(result.text).toContain("no matching data_extractor manifest found")
      expect(result.text).toContain("Do not call finny_algorithm_scaffold")
    } finally {
      await clearSessionWorkspace("ses_no_evidence")
    }
  })

  test("session build gate accepts manifest whose requested_end was clamped to the last completed session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-clamped-end-"))
    const slug = "qqq-15m-strategy"
    const sessionID = "ses_clamped_end"
    process.env.XDG_DATA_HOME = root
    const workspaceDir = path.join(root, "finny", "algos", slug)
    const dataDir = path.join(workspaceDir, "data", "stock")
    await fs.mkdir(dataDir, { recursive: true })
    // The parent's request context asks through "today" (2026-07-02); the
    // extractor correctly clamped to the last completed session (2026-07-01).
    await fs.writeFile(
      path.join(workspaceDir, "request.json"),
      JSON.stringify({
        requested_symbol: "QQQ",
        requested_interval: "15m",
        requested_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-04-03",
        requested_end: "2026-07-02",
        request_id: sessionID,
      }),
    )
    const csvRel = "stock/QQQ_15m_2026-04-03_2026-07-01.csv"
    const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
    await fs.writeFile(
      path.join(workspaceDir, "data", csvRel),
      [
        "timestamp,open,high,low,close,volume",
        "2026-07-01T19:45:00Z,560.00,561.00,559.50,560.80,100000",
        "2026-07-01T20:00:00Z,560.80,561.20,560.10,560.30,90000",
      ].join("\n"),
    )
    await fs.writeFile(
      path.join(workspaceDir, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["QQQ"],
        interval: "15m",
        requested_symbol: "QQQ",
        actual_symbol: "QQQ",
        requested_interval: "15m",
        actual_interval: "15m",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        workspace_slug: slug,
        requested_start: "2026-04-03",
        requested_end: "2026-07-01",
        actual_start: "2026-07-01T19:45:00Z",
        actual_end: "2026-07-01T20:00:00Z",
        output_path: csvRel,
        rows: 2,
        run_id: "clamped-end-run",
        coverage: "trading_day_complete",
        coverage_note: "requested_end session still open; clamped to last completed session",
        usable_for_parent: "yes",
      }),
    )
    await bindSessionWorkspace(sessionID, slug)
    try {
      const result = await requireVerifiedDataExtractorEvidenceForSession(sessionID)
      expect(result.ok).toBe(true)
      expect(result.text).toContain("usable_for_parent: yes")
    } finally {
      await clearSessionWorkspace(sessionID)
    }
  })

  test("session build gate finds evidence relocated to the linked algorithm store after save", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-relocated-"))
    const slug = "qqq-15m-linked"
    const sessionID = "ses_relocated_evidence"
    process.env.XDG_DATA_HOME = root
    const workspaceDir = path.join(root, "finny", "algos", slug)
    // Workspace data tree is empty: finny_algorithm_save moved it into the
    // algorithm store and left a symlink under <workspace>/algorithms/<name>.
    await fs.mkdir(path.join(workspaceDir, "data", "stock"), { recursive: true })
    const storeDir = path.join(root, "finny", "algorithms", "algo-id-1")
    await fs.mkdir(path.join(storeDir, "data", "stock"), { recursive: true })
    await fs.mkdir(path.join(workspaceDir, "algorithms"), { recursive: true })
    await fs.symlink(storeDir, path.join(workspaceDir, "algorithms", "qqq-15m-e2e"))
    await fs.writeFile(
      path.join(workspaceDir, "request.json"),
      JSON.stringify({
        requested_symbol: "QQQ",
        requested_interval: "15m",
        requested_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-04-03",
        requested_end: "2026-07-02",
        request_id: sessionID,
      }),
    )
    const csvRel = "stock/QQQ_15m_2026-04-03_2026-07-01.csv"
    const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
    await fs.writeFile(
      path.join(storeDir, "data", csvRel),
      [
        "timestamp,open,high,low,close,volume",
        "2026-07-01T19:45:00Z,560.00,561.00,559.50,560.80,100000",
        "2026-07-01T20:00:00Z,560.80,561.20,560.10,560.30,90000",
      ].join("\n"),
    )
    await fs.writeFile(
      path.join(storeDir, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["QQQ"],
        interval: "15m",
        requested_symbol: "QQQ",
        actual_symbol: "QQQ",
        requested_interval: "15m",
        actual_interval: "15m",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        workspace_slug: slug,
        requested_start: "2026-04-03",
        requested_end: "2026-07-01",
        actual_start: "2026-07-01T19:45:00Z",
        actual_end: "2026-07-01T20:00:00Z",
        output_path: csvRel,
        rows: 2,
        run_id: "relocated-run",
        coverage: "trading_day_complete",
        usable_for_parent: "yes",
      }),
    )
    await bindSessionWorkspace(sessionID, slug)
    try {
      const result = await requireVerifiedDataExtractorEvidenceForSession(sessionID)
      expect(result.ok).toBe(true)
      expect(result.text).toContain("usable_for_parent: yes")
    } finally {
      await clearSessionWorkspace(sessionID)
    }
  })

  test("session build gate blocks manifests whose window ends after the requested end", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-future-end-"))
    const slug = "qqq-15m-future"
    const sessionID = "ses_future_end"
    process.env.XDG_DATA_HOME = root
    const workspaceDir = path.join(root, "finny", "algos", slug)
    await fs.mkdir(path.join(workspaceDir, "data", "stock"), { recursive: true })
    await fs.writeFile(
      path.join(workspaceDir, "request.json"),
      JSON.stringify({
        requested_symbol: "QQQ",
        requested_interval: "15m",
        requested_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-04-03",
        requested_end: "2026-07-02",
        request_id: sessionID,
      }),
    )
    const csvRel = "stock/QQQ_15m_2026-04-03_2026-07-06.csv"
    const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
    await fs.writeFile(
      path.join(workspaceDir, "data", csvRel),
      [
        "timestamp,open,high,low,close,volume",
        "2026-07-06T19:45:00Z,560.00,561.00,559.50,560.80,100000",
        "2026-07-06T20:00:00Z,560.80,561.20,560.10,560.30,90000",
      ].join("\n"),
    )
    await fs.writeFile(
      path.join(workspaceDir, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["QQQ"],
        interval: "15m",
        requested_symbol: "QQQ",
        actual_symbol: "QQQ",
        requested_interval: "15m",
        actual_interval: "15m",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        workspace_slug: slug,
        requested_start: "2026-04-03",
        requested_end: "2026-07-06",
        actual_start: "2026-07-06T19:45:00Z",
        actual_end: "2026-07-06T20:00:00Z",
        output_path: csvRel,
        rows: 2,
        run_id: "future-end-run",
        coverage: "complete",
        usable_for_parent: "yes",
      }),
    )
    await bindSessionWorkspace(sessionID, slug)
    try {
      const result = await requireVerifiedDataExtractorEvidenceForSession(sessionID)
      expect(result.ok).toBe(false)
      expect(result.text).toContain("BLOCKED: evidence required before strategy build")
    } finally {
      await clearSessionWorkspace(sessionID)
    }
  })

  test("session build gate still blocks manifests from a materially different window", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-far-end-"))
    const slug = "qqq-15m-stale"
    const sessionID = "ses_far_end"
    process.env.XDG_DATA_HOME = root
    const workspaceDir = path.join(root, "finny", "algos", slug)
    const dataDir = path.join(workspaceDir, "data", "stock")
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(
      path.join(workspaceDir, "request.json"),
      JSON.stringify({
        requested_symbol: "QQQ",
        requested_interval: "15m",
        requested_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-04-03",
        requested_end: "2026-07-02",
        request_id: sessionID,
      }),
    )
    const csvRel = "stock/QQQ_15m_2026-01-05_2026-03-31.csv"
    const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
    await fs.writeFile(
      path.join(workspaceDir, "data", csvRel),
      [
        "timestamp,open,high,low,close,volume",
        "2026-03-31T19:45:00Z,520.00,521.00,519.50,520.80,100000",
        "2026-03-31T20:00:00Z,520.80,521.20,520.10,520.30,90000",
      ].join("\n"),
    )
    await fs.writeFile(
      path.join(workspaceDir, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["QQQ"],
        interval: "15m",
        requested_symbol: "QQQ",
        actual_symbol: "QQQ",
        requested_interval: "15m",
        actual_interval: "15m",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        workspace_slug: slug,
        requested_start: "2026-01-05",
        requested_end: "2026-03-31",
        actual_start: "2026-03-31T19:45:00Z",
        actual_end: "2026-03-31T20:00:00Z",
        output_path: csvRel,
        rows: 2,
        run_id: "stale-window-run",
        coverage: "complete",
        usable_for_parent: "yes",
      }),
    )
    await bindSessionWorkspace(sessionID, slug)
    try {
      const result = await requireVerifiedDataExtractorEvidenceForSession(sessionID)
      expect(result.ok).toBe(false)
      expect(result.text).toContain("BLOCKED: evidence required before strategy build")
    } finally {
      await clearSessionWorkspace(sessionID)
    }
  })

  test("blocks incomplete digest without manifest evidence", async () => {
    const result = await validateDataExtractorTaskText({
      text: "saved SPY data under stock/SPY.csv",
      workspaceSlug: "spy-5m-momentum",
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("BLOCKED: data_extractor returned incomplete evidence artifacts")
  })

  test("accepts matching CSV, manifest, and digest identity fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-"))
    const slug = "btc-q1-hourly"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "crypto")
    await fs.mkdir(dataDir, { recursive: true })
    const csvRel = "crypto/BTC-USD_1h_2024-01-01_2024-03-31.csv"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.writeFile(csvPath, "timestamp,open,high,low,close,volume\n2024-01-01T00:00:00Z,1,2,1,2,100\n")
    const manifest = {
      schema_version: 1,
      source: "binance",
      symbols: ["BTC"],
      interval: "1h",
      requested_symbol: "BTC",
      actual_symbol: "BTC",
      requested_interval: "1h",
      actual_interval: "1h",
      requested_asset_class: "crypto",
      actual_asset_class: "crypto",
      requested_algorithm_name: slug,
      requested_start: "2024-01-01",
      requested_end: "2024-03-31",
      actual_start: "2024-01-01",
      actual_end: "2024-01-01",
      output_path: csvRel,
      rows: 1,
      run_id: "run-1",
    }
    await fs.writeFile(`${csvPath.replace(/\.csv$/, ".manifest.json")}`, JSON.stringify(manifest, null, 2))

    const digest = [
      "requested_algorithm_name: btc-q1-hourly",
      "workspace_slug: btc-q1-hourly",
      "requested_symbol: BTC",
      "actual_symbol: BTC",
      "requested_interval: 1h",
      "actual_interval: 1h",
      "requested_asset_class: crypto",
      "actual_asset_class: crypto",
      "requested_start: 2024-01-01",
      "requested_end: 2024-03-31",
      "actual_start: 2024-01-01",
      "actual_end: 2024-01-01",
      `artifact_paths: ${csvRel}, ${csvRel.replace(/\.csv$/, ".manifest.json")}`,
      "run_id: run-1",
      "usable_for_parent: yes",
      "quality: duplicates=0, gaps=0, invalid_ohlc=0, zero_volume=0, outliers=0",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    expect(REQUIRED_DIGEST_FIELDS.every((field) => digest.includes(`${field}:`))).toBe(true)
  })

  test("accepts valid artifact evidence when a retry changes only run_id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-retry-run-id-"))
    const slug = "btc-15m-strategy"
    process.env.XDG_DATA_HOME = root
    const csvRel = "crypto/BTC_15m_2025-07-09_2026-07-08.csv"
    const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2025-07-09T00:00:00Z,100,101,99,100.5,10\n2025-07-09T00:15:00Z,100.5,102,100,101,12\n",
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify(
        {
          schema_version: 1,
          source: "binance",
          requested_symbol: "BTC",
          actual_symbol: "BTC",
          requested_interval: "15m",
          actual_interval: "15m",
          requested_asset_class: "crypto",
          actual_asset_class: "crypto",
          requested_algorithm_name: slug,
          requested_start: "2025-07-09",
          requested_end: "2026-07-09",
          actual_start: "2025-07-09T00:00:00Z",
          actual_end: "2025-07-09T00:15:00Z",
          output_path: csvRel,
          rows: 2,
          run_id: "20260709T043814Z-binance-btc-15m",
          coverage: "complete",
          usable_for_parent: "yes",
        },
        null,
        2,
      ),
    )

    const digest = [
      `requested_algorithm_name: ${slug}`,
      `workspace_slug: ${slug}`,
      "requested_symbol: BTC",
      "actual_symbol: BTC",
      "requested_interval: 15m",
      "actual_interval: 15m",
      "requested_asset_class: crypto",
      "actual_asset_class: crypto",
      "requested_start: 2025-07-09",
      "requested_end: 2026-07-09",
      "actual_start: 2025-07-09T00:00:00Z",
      "actual_end: 2025-07-09T00:15:00Z",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: 20260709T003814Z-binance-btc-15m",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("run_id: 20260709T043814Z-binance-btc-15m")
  })

  test("reuses existing BTC evidence when actual_symbol has a provider annotation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-btc-annotated-existing-"))
    const slug = "btc-15m-strategy"
    process.env.XDG_DATA_HOME = root
    const csvRel = "crypto/BTC_15m_2025-07-09_2026-07-08.csv"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2025-07-09T00:00:00Z,100,101,99,100.5,10\n2025-07-09T00:15:00Z,100.5,102,100,101,12\n",
    )
    await fs.writeFile(
      csvPath.replace(/\.csv$/, ".manifest.json"),
      JSON.stringify(
        {
          schema_version: 1,
          source: "binance",
          requested_symbol: "BTC",
          actual_symbol: "BTC (BTCUSDT spot)",
          requested_interval: "15m",
          actual_interval: "15m",
          requested_asset_class: "crypto",
          actual_asset_class: "crypto",
          requested_algorithm_name: slug,
          requested_start: "2025-07-09",
          requested_end: "2026-07-09",
          actual_start: "2025-07-09T00:00:00Z",
          actual_end: "2025-07-09T00:15:00Z",
          output_path: csvRel,
          rows: 2,
          run_id: "20260709T043814Z-binance-btc-15m",
          coverage: "complete",
          usable_for_parent: "yes",
        },
        null,
        2,
      ),
    )

    const existing = await validateExistingDataExtractorEvidence({
      workspaceSlug: slug,
      context: {
        request_id: "ses_btc",
        requested_symbol: "BTC",
        requested_interval: "15m",
        requested_asset_class: "crypto",
        requested_algorithm_name: slug,
        requested_start: "2025-07-09",
        requested_end: "2026-07-09",
      },
    })
    expect(existing.found).toBe(true)
    expect(existing.result?.ok).toBe(true)
  })

  test("blocks internally consistent evidence when symbol is outside runtime universe", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-context-universe-"))
    const slug = "djt-rum-geo-cxw-1d-strategy"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "stock")
    await fs.mkdir(dataDir, { recursive: true })
    const csvRel = "stock/ES_1d_2026-01-01_2026-06-30.csv"
    const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.writeFile(csvPath, "timestamp,open,high,low,close,volume\n2026-01-02T00:00:00Z,1,2,1,2,100\n")
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        requested_symbol: "ES",
        actual_symbol: "ES",
        requested_interval: "1d",
        actual_interval: "1d",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-01-01",
        requested_end: "2026-06-30",
        actual_start: "2026-01-02",
        actual_end: "2026-01-02",
        output_path: csvRel,
        rows: 1,
        run_id: "wrong-symbol",
        coverage: "complete",
      }),
    )

    const digest = [
      `requested_algorithm_name: ${slug}`,
      `workspace_slug: ${slug}`,
      "requested_symbol: ES",
      "actual_symbol: ES",
      "requested_interval: 1d",
      "actual_interval: 1d",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2026-01-01",
      "requested_end: 2026-06-30",
      "actual_start: 2026-01-02",
      "actual_end: 2026-01-02",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: wrong-symbol",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({
      text: digest,
      workspaceSlug: slug,
      context: {
        request_id: "ses_trump",
        requested_symbols: ["DJT", "RUM", "GEO", "CXW"],
        requested_interval: "1d",
        requested_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-01-01",
        requested_end: "2026-06-30",
      },
    })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("requested_symbol differs from runtime context universe")
    expect(result.text).toContain("actual_symbol differs from runtime context universe")
  })

  test("normalizes boolean manifest usable_for_parent instead of throwing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-boolean-usable-"))
    const slug = "btc-daily-strategy"
    process.env.XDG_DATA_HOME = root
    const csvRel = "crypto/BTC-USD_1d_2025-12-31_2026-06-29.csv"
    const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2025-12-31T00:00:00Z,1,2,1,2,100\n2026-06-29T00:00:00Z,2,3,2,3,100\n",
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify(
        {
          schema_version: 1,
          source: "binance",
          requested_symbol: "BTC.USD",
          actual_symbol: "BTC.USD",
          requested_interval: "1d",
          actual_interval: "1d",
          requested_asset_class: "crypto",
          actual_asset_class: "crypto",
          requested_algorithm_name: slug,
          requested_start: "2025-12-31",
          requested_end: "2026-06-29",
          actual_start: "2025-12-31",
          actual_end: "2026-06-29",
          output_path: csvRel,
          rows: 2,
          run_id: "boolean-usable",
          coverage: "complete",
          usable_for_parent: true,
        },
        null,
        2,
      ),
    )

    const digest = [
      `requested_algorithm_name: ${slug}`,
      `workspace_slug: ${slug}`,
      "requested_symbol: BTC.USD",
      "actual_symbol: BTC.USD",
      "requested_interval: 1d",
      "actual_interval: 1d",
      "requested_asset_class: crypto",
      "actual_asset_class: crypto",
      "requested_start: 2025-12-31",
      "requested_end: 2026-06-29",
      "actual_start: 2025-12-31",
      "actual_end: 2026-06-29",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: boolean-usable",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("usable_for_parent: yes")
  })

  test("accepts date-only manifest boundaries when CSV timestamps fall on those UTC dates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-date-boundary-"))
    const slug = "spy-date-boundaries"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "stock")
    await fs.mkdir(dataDir, { recursive: true })
    const csvRel = "stock/SPY_15m.csv"
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", csvRel),
      "timestamp,open,high,low,close,volume\n2026-03-23T12:00:00Z,1,2,1,2,100\n2026-03-23T12:15:00Z,2,3,2,3,100\n",
    )
    const manifest = {
      schema_version: 1,
      source: "alpaca",
      requested_symbol: "SPY",
      actual_symbol: "SPY",
      requested_interval: "15m",
      actual_interval: "15m",
      requested_asset_class: "equity",
      actual_asset_class: "equity",
      requested_algorithm_name: "spy-date-boundaries",
      requested_start: "2026-03-23",
      requested_end: "2026-03-23",
      actual_start: "2026-03-23",
      actual_end: "2026-03-23",
      output_path: csvRel,
      rows: 2,
      run_id: "date-boundaries",
      coverage: "trading_day_complete",
    }
    const manifestRel = "stock/SPY_15m.manifest.json"
    await fs.writeFile(path.join(root, "finny", "algos", slug, "data", manifestRel), JSON.stringify(manifest))
    const text = [
      "requested_algorithm_name: spy-date-boundaries",
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 15m",
      "actual_interval: 15m",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2026-03-23",
      "requested_end: 2026-03-23",
      "actual_start: 2026-03-23",
      "actual_end: 2026-03-23",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: date-boundaries",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("usable_for_parent: yes")
  })

  test("accepts Polygon aggregate evidence for equity CSV manifests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-polygon-"))
    const slug = "spy-polygon-daily"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "stock")
    await fs.mkdir(dataDir, { recursive: true })
    const csvRel = "stock/SPY_1d_2024-01-02_2024-01-03.csv"
    const manifestRel = "stock/SPY_1d_2024-01-02_2024-01-03.manifest.json"
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", csvRel),
      [
        "timestamp,open,high,low,close,volume",
        "2024-01-02T05:00:00Z,470.00,475.00,468.00,474.00,1000000",
        "2024-01-03T05:00:00Z,474.00,476.00,471.00,472.00,1100000",
      ].join("\n"),
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "polygon",
        symbols: ["SPY"],
        interval: "1d",
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "1d",
        actual_interval: "1d",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2024-01-02",
        requested_end: "2024-01-03",
        actual_start: "2024-01-02",
        actual_end: "2024-01-03",
        output_path: csvRel,
        rows: 2,
        run_id: "polygon-run-1",
        coverage: "complete",
        usable_for_parent: "yes",
      }),
    )

    const digest = [
      `requested_algorithm_name: ${slug}`,
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 1d",
      "actual_interval: 1d",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2024-01-02",
      "requested_end: 2024-01-03",
      "actual_start: 2024-01-02",
      "actual_end: 2024-01-03",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: polygon-run-1",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
  })

  test("accepts Binance numeric epoch millisecond timestamps in crypto CSV evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-binance-epoch-"))
    const slug = "btc-15m-momentum"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "crypto")
    await fs.mkdir(dataDir, { recursive: true })
    const csvRel = "crypto/BTC_15m_2026-06-11_2026-06-18.csv"
    const manifestRel = "crypto/BTC_15m_2026-06-11_2026-06-18.manifest.json"
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", csvRel),
      [
        "timestamp,open,high,low,close,volume",
        "1781136000000,61510.99000000,61692.10000000,61510.99000000,61690.01000000,130.11216000",
        "1781136900000,61690.00000000,61974.70000000,61690.00000000,61884.00000000,200.30491000",
      ].join("\n"),
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify(
        {
          schema_version: 1,
          source: "binance",
          requested_symbol: "BTC",
          actual_symbol: "BTC",
          requested_interval: "15m",
          actual_interval: "15m",
          requested_asset_class: "crypto",
          actual_asset_class: "crypto",
          requested_algorithm_name: slug,
          requested_start: "2026-06-11",
          requested_end: "2026-06-18",
          actual_start: "2026-06-11",
          actual_end: "2026-06-11",
          output_path: csvRel,
          rows: 2,
          run_id: "run-binance-epoch",
          coverage: "complete",
        },
        null,
        2,
      ),
    )

    const text = [
      `workspace_slug: ${slug}`,
      "requested_symbol: BTC",
      "actual_symbol: BTC",
      "requested_interval: 15m",
      "actual_interval: 15m",
      "requested_asset_class: crypto",
      "actual_asset_class: crypto",
      "requested_algorithm_name: btc-15m-momentum",
      "requested_start: 2026-06-11",
      "requested_end: 2026-06-18",
      "actual_start: 2026-06-11",
      "actual_end: 2026-06-11",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: run-binance-epoch",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("usable_for_parent: yes")
  })

  test("blocks header-only CSV even when manifest exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-header-"))
    const slug = "spy-header-only"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "stock")
    await fs.mkdir(dataDir, { recursive: true })
    const csvRel = "stock/SPY_5m_2024-01-01_2024-03-31.csv"
    const csvPath = path.join(dataDir, "SPY_5m_2024-01-01_2024-03-31.csv")
    await fs.writeFile(csvPath, "timestamp,open,high,low,close,volume\n")
    await fs.writeFile(
      `${csvPath.replace(/\.csv$/, ".manifest.json")}`,
      JSON.stringify(
        {
          requested_symbol: "SPY",
          actual_symbol: "SPY",
          requested_interval: "5m",
          actual_interval: "5m",
          requested_asset_class: "equity",
          actual_asset_class: "equity",
          requested_algorithm_name: slug,
          requested_start: "2024-01-01",
          requested_end: "2024-03-31",
          actual_start: "2024-01-01",
          actual_end: "2024-01-01",
          output_path: csvRel,
          rows: 0,
          run_id: "run-header",
        },
        null,
        2,
      ),
    )

    const digest = [
      "requested_algorithm_name: spy-header-only",
      "workspace_slug: spy-header-only",
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 5m",
      "actual_interval: 5m",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2024-01-01",
      "requested_end: 2024-03-31",
      "actual_start: 2024-01-01",
      "actual_end: 2024-01-01",
      `artifact_paths: ${csvRel}`,
      "run_id: run-header",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("header-only")
  })

  test("accepts table-style digest when CSV and manifest evidence are valid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-table-"))
    const slug = "btc-1h-mean-reversion"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "crypto")
    await fs.mkdir(dataDir, { recursive: true })
    const csvRel = "crypto/BTC-USD_1h_2024-01-01_2024-03-31.csv"
    const manifestRel = "crypto/BTC-USD_1h_2024-01-01_2024-03-31.manifest.json"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2024-01-01T00:00:00Z,1,2,1,2,100\n2024-01-01T01:00:00Z,2,3,2,3,100\n",
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify(
        {
          requested_symbol: "BTC-USD",
          actual_symbol: "BTC-USD",
          requested_interval: "1h",
          actual_interval: "1h",
          requested_asset_class: "crypto",
          actual_asset_class: "crypto",
          requested_algorithm_name: slug,
          requested_start: "2024-01-01",
          requested_end: "2024-03-31",
          actual_start: "2024-01-01T00:00:00Z",
          actual_end: "2024-01-01T01:00:00Z",
          output_path: csvRel,
          rows: 2,
          run_id: "run-table",
          coverage: "complete",
          usable_for_parent: "yes",
        },
        null,
        2,
      ),
    )

    const digest = [
      "Data Extraction Summary",
      "Identity",
      "Value",
      "BTC-USD",
      "BTC-USD",
      "1h",
      "1h",
      "Window Coverage",
      "usable_for_parent yes",
      "Artifact Paths",
      `CSV: ${csvRel} (123 bytes)`,
      `Manifest: ${manifestRel} (456 bytes)`,
      "Statistics: mean price and std dev were computed from saved rows.",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
  })

  test("accepts table and JSON artifact paths from a human-formatted final summary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-human-summary-"))
    const slug = "spy-strategy.21.6.23.32.b2859eb3"
    process.env.XDG_DATA_HOME = root
    const csvRel = "stock/SPY_1d_2025-06-21_2026-06-21.csv"
    const manifestRel = "stock/SPY_1d_2025-06-21_2026-06-21.manifest.json"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2025-06-23T04:00:00Z,600,610,590,605,1000000\n2026-06-18T04:00:00Z,740,750,730,746.75,1200000\n",
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["SPY"],
        interval: "1d",
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "1d",
        actual_interval: "1d",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: "spy-strategy",
        requested_start: "2025-06-21",
        requested_end: "2026-06-21",
        actual_start: "2025-06-23",
        actual_end: "2026-06-18",
        output_path: csvRel,
        rows: 2,
        run_id: "20260621T233200Z-spy",
        coverage: "trading_day_complete",
        usable_for_parent: "yes",
      }),
    )

    const digest = [
      "SPY Daily OHLCV Extraction Complete",
      "Request Identity",
      "Field",
      "requested_algorithm_name",
      "workspace_slug",
      "requested_symbol",
      "Artifact Paths",
      "Artifact\tPath",
      `CSV\t${csvRel} (14,567 bytes)`,
      `Manifest\t${manifestRel}`,
      "Return Summary",
      "{",
      '  "identity": { "symbol": "SPY", "interval": "1d", "asset_class": "equity", "algorithm": "spy-strategy" },',
      '  "coverage": { "status": "trading_day_complete", "bars": 250, "requested": "2025-06-21 -> 2026-06-21", "actual": "2025-06-23 -> 2026-06-18", "usable": true },',
      `  "paths": { "csv": "${csvRel}", "manifest": "${manifestRel}" },`,
      '  "source": "alpaca"',
      "}",
      "Data is ready for backtesting. No blockers identified.",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("<data-extractor-manifest>")
    expect(result.text).toContain("usable_for_parent: yes")
    expect(result.text).toContain(`artifact_paths: ${csvRel}, ${manifestRel}`)
  })

  test("reports manifest usability instead of a path error when prose annotates actual_symbol", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-annotated-symbol-"))
    const slug = "btc-1h-strategy"
    process.env.XDG_DATA_HOME = root
    const csvRel = "crypto/BTC-USD_1h_2026-03-21_2026-06-18.csv"
    const manifestRel = csvRel.replace(/\.csv$/, ".manifest.json")
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(csvPath, "timestamp,open,high,low,close,volume\n2026-03-21T00:00:00Z,1,2,1,2,100\n")
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify({
        requested_symbol: "BTC",
        actual_symbol: "BTC-USD",
        requested_interval: "1h",
        actual_interval: "1h",
        requested_asset_class: "crypto",
        actual_asset_class: "crypto",
        requested_algorithm_name: slug,
        requested_start: "2026-03-21",
        requested_end: "2026-06-18",
        actual_start: "2026-03-21T00:00:00Z",
        actual_end: "2026-06-17T23:00:00Z",
        output_path: csvRel,
        rows: 1,
        run_id: "run-btc-fallback",
        coverage: "partial",
        usable_for_parent: "no",
      }),
    )
    const digest = [
      `requested_algorithm_name: ${slug}`,
      `workspace_slug: ${slug}`,
      "requested_symbol: BTC",
      "actual_symbol: BTC-USD (yfinance symbol)",
      "requested_interval: 1h",
      "actual_interval: 1h",
      "requested_asset_class: crypto",
      "actual_asset_class: crypto",
      "requested_start: 2026-03-21",
      "requested_end: 2026-06-18",
      "actual_start: 2026-03-21T00:00:00Z",
      "actual_end: 2026-06-17T23:00:00Z",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: run-btc-fallback",
      "usable_for_parent: no",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("marked evidence unusable_for_parent")
    expect(result.text).not.toContain("could not resolve manifest path")
  })

  test("falls back to the session workspace manifest when artifact_paths are missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-fallback-"))
    const slug = "eth-1h-mean-reversion"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "crypto")
    await fs.mkdir(dataDir, { recursive: true })
    const csvRel = "crypto/ETH-USD_1h_2024-01-01_2024-03-31.csv"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2024-01-01T00:00:00Z,1,2,1,2,100\n2024-01-01T01:00:00Z,2,3,2,3,100\n",
    )
    await fs.writeFile(
      csvPath.replace(/\.csv$/, ".manifest.json"),
      JSON.stringify(
        {
          requested_symbol: "ETH-USD",
          actual_symbol: "ETH-USD",
          requested_interval: "1h",
          actual_interval: "1h",
          requested_asset_class: "crypto",
          actual_asset_class: "crypto",
          requested_algorithm_name: slug,
          requested_start: "2024-01-01",
          requested_end: "2024-03-31",
          actual_start: "2024-01-01T00:00:00Z",
          actual_end: "2024-01-01T01:00:00Z",
          output_path: csvRel,
          rows: 2,
          run_id: "run-eth",
          coverage: "complete",
        },
        null,
        2,
      ),
    )

    const result = await validateDataExtractorTaskText({
      text: "Data extraction complete. CSV and manifest were written and verified for the full requested window.",
      workspaceSlug: slug,
    })
    expect(result.ok).toBe(true)
  })

  test("derives usable yes for clean trading-day-complete evidence when the manifest flag is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-trading-day-"))
    const slug = "spy-15m-breakout"
    process.env.XDG_DATA_HOME = root
    const csvRel = "stock/SPY_15m_2026-03-21_2026-06-18.csv"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2026-03-23T13:30:00Z,1,2,1,2,100\n2026-03-23T13:45:00Z,2,3,2,3,100\n",
    )
    await fs.writeFile(
      csvPath.replace(/\.csv$/, ".manifest.json"),
      JSON.stringify({
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "15m",
        actual_interval: "15m",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-03-21",
        requested_end: "2026-06-18",
        actual_start: "2026-03-23T13:30:00Z",
        actual_end: "2026-03-23T13:45:00Z",
        output_path: csvRel,
        rows: 2,
        run_id: "run-spy-15m",
        coverage: "trading_day_complete",
      }),
    )
    const digest = [
      `requested_algorithm_name: ${slug}`,
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 15m",
      "actual_interval: 15m",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2026-03-21",
      "requested_end: 2026-06-18",
      "actual_start: 2026-03-23T13:30:00Z",
      "actual_end: 2026-03-23T13:45:00Z",
      `artifact_paths: ${csvRel}, ${csvRel.replace(/\.csv$/, ".manifest.json")}`,
      "run_id: run-spy-15m",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    expect(result.text).toContain("<data-extractor-manifest>")
    expect(result.text).toContain("usable_for_parent: yes")
  })

  test("rejects a 15m artifact whose timestamps reveal 5m bars", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-cadence-"))
    const slug = "spy-15m-wrong-cadence"
    process.env.XDG_DATA_HOME = root
    const csvRel = "stock/SPY_15m.csv"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2026-03-23T13:30:00Z,1,2,1,2,100\n2026-03-23T13:35:00Z,2,3,2,3,100\n",
    )
    await fs.writeFile(
      csvPath.replace(/\.csv$/, ".manifest.json"),
      JSON.stringify({
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "15m",
        actual_interval: "15m",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-03-21",
        requested_end: "2026-06-18",
        actual_start: "2026-03-23T13:30:00Z",
        actual_end: "2026-03-23T13:35:00Z",
        output_path: csvRel,
        rows: 2,
        run_id: "run-wrong-cadence",
        coverage: "trading_day_complete",
      }),
    )
    const digest = [
      `requested_algorithm_name: ${slug}`,
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 15m",
      "actual_interval: 15m",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2026-03-21",
      "requested_end: 2026-06-18",
      "actual_start: 2026-03-23T13:30:00Z",
      "actual_end: 2026-03-23T13:35:00Z",
      `artifact_paths: ${csvRel}`,
      "run_id: run-wrong-cadence",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(false)
    expect(result.text).toContain("requested 15m, observed 5m")
  })

  test("recovers canonical paths from the only identity-matching manifest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-path-recovery-"))
    const slug = "spy-path-recovery"
    process.env.XDG_DATA_HOME = root
    const csvRel = "stock/SPY_15m_actual.csv"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(csvPath, "timestamp,open,high,low,close,volume\n2026-03-23T13:30:00Z,1,2,1,2,100\n")
    await fs.writeFile(
      csvPath.replace(/\.csv$/, ".manifest.json"),
      JSON.stringify({
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "15m",
        actual_interval: "15m",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: slug,
        requested_start: "2026-03-21",
        requested_end: "2026-06-18",
        actual_start: "2026-03-23T13:30:00Z",
        actual_end: "2026-03-23T13:30:00Z",
        output_path: csvRel,
        rows: 1,
        run_id: "run-path",
        coverage: "complete",
      }),
    )
    const digest = [
      `requested_algorithm_name: ${slug}`,
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 15m",
      "actual_interval: 15m",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2026-03-21",
      "requested_end: 2026-06-18",
      "actual_start: 2026-03-23T13:30:00Z",
      "actual_end: 2026-03-23T13:30:00Z",
      "artifact_paths: stock/hallucinated.csv, stock/hallucinated.manifest.json",
      "run_id: run-path",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    expect(result.text.split("<data-extractor-manifest>")[1]).toContain(csvRel)

    await fs.copyFile(
      csvPath.replace(/\.csv$/, ".manifest.json"),
      path.join(path.dirname(csvPath), "duplicate.manifest.json"),
    )
    const ambiguous = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.text).toContain("could not resolve a unique identity-matching manifest (2 candidates)")
  })

  test("accepts clean completed bars when only the current candle is unavailable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-open-candle-"))
    const slug = "btc-1d-trend-following"
    process.env.XDG_DATA_HOME = root
    const dataDir = path.join(root, "finny", "algos", slug, "data", "crypto")
    await fs.mkdir(dataDir, { recursive: true })

    const today = new Date().toISOString().slice(0, 10)
    const yesterdayDate = new Date(`${today}T00:00:00Z`)
    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1)
    const yesterday = yesterdayDate.toISOString().slice(0, 10)
    const csvRel = `crypto/BTCUSDT_1d_2025-06-16_${today}.csv`
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.writeFile(
      csvPath,
      `timestamp,open,high,low,close,volume\n2025-06-16,100,110,90,105,1000\n${yesterday},105,115,95,110,1000\n`,
    )
    await fs.writeFile(
      csvPath.replace(/\.csv$/, ".manifest.json"),
      JSON.stringify(
        {
          requested_symbol: "BTC",
          actual_symbol: "BTCUSDT",
          requested_interval: "1d",
          actual_interval: "1d",
          requested_asset_class: "crypto",
          actual_asset_class: "crypto",
          requested_algorithm_name: slug,
          requested_start: "2025-06-16",
          requested_end: today,
          actual_start: "2025-06-16",
          actual_end: yesterday,
          output_path: csvRel,
          rows: 2,
          run_id: "run-open-candle",
          coverage: "partial",
          coverage_note: `${today} daily candle is still open; saved completed bars through ${yesterday}`,
          usable_for_parent: "no",
        },
        null,
        2,
      ),
    )

    const digest = [
      "requested_algorithm_name: btc-1d-trend-following",
      "workspace_slug: btc-1d-trend-following",
      "request_id: ses_test",
      "requested_symbol: BTC",
      "actual_symbol: BTCUSDT",
      "requested_interval: 1d",
      "actual_interval: 1d",
      "requested_asset_class: crypto",
      "actual_asset_class: crypto",
      "requested_start: 2025-06-16",
      `requested_end: ${today}`,
      "actual_start: 2025-06-16",
      `actual_end: ${yesterday}`,
      `artifact_paths: ${csvRel}, ${csvRel.replace(/\.csv$/, ".manifest.json")}`,
      "run_id: run-open-candle",
      "coverage: partial; requested_end excluded because current daily candle was not closed",
      "quality: rows=2, duplicates=0, gaps=0, invalid_ohlc=0, zero_volume=0, outliers=0, partial_provider_coverage=yes",
      "usable_for_parent: no — full requested window not covered",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
  })

  test("preserves optional analysis_summary fields in the manifest block", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-analysis-"))
    const slug = "spy-analysis.21.6.23.32.aa11bb22"
    process.env.XDG_DATA_HOME = root
    const csvRel = "stock/SPY_1d_2025-06-21_2026-06-21.csv"
    const manifestRel = "stock/SPY_1d_2025-06-21_2026-06-21.manifest.json"
    const summaryRel = "stock/SPY_1d_2025-06-21_2026-06-21.analysis_summary.json"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2025-06-23T04:00:00Z,600,610,590,605,1000000\n2026-06-18T04:00:00Z,740,750,730,746.75,1200000\n",
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["SPY"],
        interval: "1d",
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "1d",
        actual_interval: "1d",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: "spy-analysis",
        requested_start: "2025-06-21",
        requested_end: "2026-06-21",
        actual_start: "2025-06-23",
        actual_end: "2026-06-18",
        output_path: csvRel,
        rows: 2,
        run_id: "20260621T233200Z-spy",
        coverage: "trading_day_complete",
        usable_for_parent: "yes",
        analysis_summary_path: summaryRel,
        analysis_regime: "trending_up",
        analysis_hypotheses: [
          "Candidate trend continuation after shallow pullbacks; requires backtest.",
          "Candidate breakouts above prior swing highs; requires backtest.",
        ],
      }),
    )

    const digest = [
      "requested_algorithm_name: spy-analysis",
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 1d",
      "actual_interval: 1d",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2025-06-21",
      "requested_end: 2026-06-21",
      "actual_start: 2025-06-23",
      "actual_end: 2026-06-18",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: 20260621T233200Z-spy",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    const block = result.text.split("<data-extractor-manifest>")[1]
    expect(block).toContain("analysis_regime: trending_up")
    expect(block).toContain(
      "analysis_hypotheses: Candidate trend continuation after shallow pullbacks; requires backtest. | Candidate breakouts above prior swing highs; requires backtest.",
    )
    expect(block).toContain(`analysis_summary_path: ${summaryRel}`)
  })

  test("manifest without analysis fields still validates and omits them from the block", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-no-analysis-"))
    const slug = "spy-plain.21.6.23.32.cc33dd44"
    process.env.XDG_DATA_HOME = root
    const csvRel = "stock/SPY_1d_2025-06-21_2026-06-21.csv"
    const manifestRel = "stock/SPY_1d_2025-06-21_2026-06-21.manifest.json"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2025-06-23T04:00:00Z,600,610,590,605,1000000\n2026-06-18T04:00:00Z,740,750,730,746.75,1200000\n",
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["SPY"],
        interval: "1d",
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "1d",
        actual_interval: "1d",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: "spy-plain",
        requested_start: "2025-06-21",
        requested_end: "2026-06-21",
        actual_start: "2025-06-23",
        actual_end: "2026-06-18",
        output_path: csvRel,
        rows: 2,
        run_id: "20260621T233200Z-spy",
        coverage: "trading_day_complete",
        usable_for_parent: "yes",
      }),
    )

    const digest = [
      "requested_algorithm_name: spy-plain",
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 1d",
      "actual_interval: 1d",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2025-06-21",
      "requested_end: 2026-06-21",
      "actual_start: 2025-06-23",
      "actual_end: 2026-06-18",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: 20260621T233200Z-spy",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    const block = result.text.split("<data-extractor-manifest>")[1]
    expect(block).not.toContain("analysis_regime")
    expect(block).not.toContain("analysis_hypotheses")
    expect(block).not.toContain("analysis_summary_path")
  })

  test("malformed analysis_hypotheses (null/object entries) never throws or blocks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-malformed-hyp-"))
    const slug = "spy-malformed.21.6.23.32.ee55ff66"
    process.env.XDG_DATA_HOME = root
    const csvRel = "stock/SPY_1d_2025-06-21_2026-06-21.csv"
    const manifestRel = "stock/SPY_1d_2025-06-21_2026-06-21.manifest.json"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2025-06-23T04:00:00Z,600,610,590,605,1000000\n2026-06-18T04:00:00Z,740,750,730,746.75,1200000\n",
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["SPY"],
        interval: "1d",
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "1d",
        actual_interval: "1d",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: "spy-malformed",
        requested_start: "2025-06-21",
        requested_end: "2026-06-21",
        actual_start: "2025-06-23",
        actual_end: "2026-06-18",
        output_path: csvRel,
        rows: 2,
        run_id: "20260621T233200Z-spy",
        coverage: "trading_day_complete",
        usable_for_parent: "yes",
        analysis_regime: "trending_up",
        // Hand-written / failed update: non-string entries must be tolerated, not crash.
        analysis_hypotheses: [null, { bad: 1 }, 42, "Candidate trend continuation; requires backtest."],
      }),
    )

    const digest = [
      "requested_algorithm_name: spy-malformed",
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 1d",
      "actual_interval: 1d",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2025-06-21",
      "requested_end: 2026-06-21",
      "actual_start: 2025-06-23",
      "actual_end: 2026-06-18",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: 20260621T233200Z-spy",
      "usable_for_parent: yes",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(true)
    const block = result.text.split("<data-extractor-manifest>")[1]
    // Only the valid string survives; junk entries are dropped, not rendered.
    expect(block).toContain("analysis_hypotheses: Candidate trend continuation; requires backtest.")
    expect(block).not.toContain("[object Object]")
  })

  test("analysis_*: not_returned does not mask estimated-metric language elsewhere", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-evidence-estmask-"))
    const slug = "spy-estmask.21.6.23.32.77aa88bb"
    process.env.XDG_DATA_HOME = root
    const csvRel = "stock/SPY_1d_2025-06-21_2026-06-21.csv"
    const manifestRel = "stock/SPY_1d_2025-06-21_2026-06-21.manifest.json"
    const csvPath = path.join(root, "finny", "algos", slug, "data", csvRel)
    await fs.mkdir(path.dirname(csvPath), { recursive: true })
    await fs.writeFile(
      csvPath,
      "timestamp,open,high,low,close,volume\n2025-06-23T04:00:00Z,600,610,590,605,1000000\n2026-06-18T04:00:00Z,740,750,730,746.75,1200000\n",
    )
    await fs.writeFile(
      path.join(root, "finny", "algos", slug, "data", manifestRel),
      JSON.stringify({
        schema_version: 1,
        source: "alpaca",
        symbols: ["SPY"],
        interval: "1d",
        requested_symbol: "SPY",
        actual_symbol: "SPY",
        requested_interval: "1d",
        actual_interval: "1d",
        requested_asset_class: "equity",
        actual_asset_class: "equity",
        requested_algorithm_name: "spy-estmask",
        requested_start: "2025-06-21",
        requested_end: "2026-06-21",
        actual_start: "2025-06-23",
        actual_end: "2026-06-18",
        output_path: csvRel,
        rows: 2,
        run_id: "20260621T233200Z-spy",
        coverage: "trading_day_complete",
        usable_for_parent: "yes",
      }),
    )

    // Only `not_returned` token is on an analysis line; estimated CAGR language sits elsewhere.
    const digest = [
      "requested_algorithm_name: spy-estmask",
      `workspace_slug: ${slug}`,
      "requested_symbol: SPY",
      "actual_symbol: SPY",
      "requested_interval: 1d",
      "actual_interval: 1d",
      "requested_asset_class: equity",
      "actual_asset_class: equity",
      "requested_start: 2025-06-21",
      "requested_end: 2026-06-21",
      "actual_start: 2025-06-23",
      "actual_end: 2026-06-18",
      `artifact_paths: ${csvRel}, ${manifestRel}`,
      "run_id: 20260621T233200Z-spy",
      "usable_for_parent: yes",
      "performance: CAGR 18% over the window",
      "analysis_regime: not_returned",
    ].join("\n")

    const result = await validateDataExtractorTaskText({ text: digest, workspaceSlug: slug })
    expect(result.ok).toBe(false)
    expect(result.text.toLowerCase()).toContain("estimated metric")
  })
})

describe("data_extractor analysis summary contract", () => {
  const promptPath = path.join(import.meta.dir, "../../src/agent/prompt/finny-data-extractor.txt")
  const cookbookPath = path.join(import.meta.dir, "../../../../data-agent/instructions.md")

  test("prompt declares the optional analysis digest fields", async () => {
    const prompt = await fs.readFile(promptPath, "utf8")
    expect(prompt).toContain("analysis_summary_path:")
    expect(prompt).toContain("analysis_regime:")
    expect(prompt).toContain("analysis_hypotheses:")
  })

  test("prompt and cookbook require candidate / requires-backtest wording, not confirmed edge", async () => {
    const prompt = await fs.readFile(promptPath, "utf8")
    const cookbook = await fs.readFile(cookbookPath, "utf8")
    expect(prompt.toLowerCase()).toContain("candidate")
    expect(prompt.toLowerCase()).toContain("requires backtest")
    expect(cookbook).toContain("requires backtest")
    const hypotheses = Array.from(cookbook.matchAll(/"(Candidate [^"]*?requires backtest\.)"/g), (m) => m[1])
    expect(hypotheses.length).toBeGreaterThan(0)
    for (const h of hypotheses) expect(h.toLowerCase().startsWith("candidate ")).toBe(true)
  })

  test("cookbook recipe never asserts confirmed edge in generated hypotheses", async () => {
    const cookbook = await fs.readFile(cookbookPath, "utf8")
    const hypotheses = Array.from(cookbook.matchAll(/"(Candidate [^"]*?)"/g), (m) => m[1].toLowerCase())
    for (const h of hypotheses) {
      expect(h).not.toContain("profitable")
      expect(h).not.toMatch(/\bedge\b/)
      expect(h).not.toContain("works")
    }
  })
})

describe("phoenix trace grader", () => {
  test("classifies old failing signatures and clean synthetic runs", () => {
    expect(classifyText("tool call glob blocked")).toContain("unavailable_tool")
    expect(classifyText("Data Agent bash write blocked: algos/_template/data/stock/foo.csv")).toContain(
      "bad_write_path",
    )
    expect(classifyText("BLOCKED: data_extractor returned incomplete evidence artifacts: missing manifest")).toContain(
      "missing_manifest",
    )
    expect(classifyText("BLOCKED: context mismatch — requested SPY 5min equity")).toContain("identity_mismatch")
    expect(classifyText("estimated mean close 420.5")).toContain("estimated_metric")
    expect(classifyText("BLOCKED: provider limit for SPY 5m yfinance")).toContain("provider_limit_handled")
    expect(classifyText("Data quality failed before resample")).toContain("strict_quality_mismatch")
    expect(classifyText("frontmatter is not valid YAML status: draft")).toContain("mission_yaml_failure")
    expect(classifyText("LOOKAHEAD_BIAS_FLOW same-bar lookahead")).toContain("lookahead_validation")
    expect(classifyText("usable_for_parent: yes, manifest verified")).toEqual(["clean"])
  })

  test("groups spans by session", () => {
    const grades = gradeSessions([
      {
        span_id: "s1",
        trace_id: "t1",
        session_id: "ses_a",
        name: "task data_extractor",
        attributes: { "session.id": "ses_a", message: "BLOCKED: context mismatch" },
      },
      {
        span_id: "s2",
        trace_id: "t1",
        session_id: "ses_a",
        name: "bash",
        attributes: { "session.id": "ses_a" },
      },
      {
        span_id: "s3",
        trace_id: "t2",
        session_id: "ses_b",
        name: "finny_algorithm_save",
        attributes: { "session.id": "ses_b", message: "usable_for_parent: yes, manifest verified" },
      },
    ])
    expect(grades).toHaveLength(2)
    expect(grades.find((g) => g.session_id === "ses_a")?.critical).toContain("identity_mismatch")
    expect(grades.find((g) => g.session_id === "ses_b")?.classes).toEqual(["clean"])
  })
})
