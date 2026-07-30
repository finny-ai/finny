import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { finalizeDatasetEvidenceFile } from "../../src/tool/dataset-evidence-finalize"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-dsv2-finalizer-"))
  roots.push(root)
  const dataRoot = path.join(root, "data")
  await fs.mkdir(path.join(dataRoot, "crypto"), { recursive: true })
  const csvPath = "crypto/BTC_1d_2026-07-13_2026-07-15.csv"
  await fs.writeFile(
    path.join(dataRoot, csvPath),
    [
      "timestamp,open,high,low,close,volume",
      "2026-07-13T00:00:00Z,100,105,99,104,1000",
      "2026-07-14T00:00:00Z,104,108,103,107,1200",
      "2026-07-15T00:00:00Z,107,110,106,109,900",
    ].join("\n"),
  )
  return { dataRoot, csvPath }
}

const request = {
  request_id: "request-btc-daily",
  request_version: 3,
  request_content_hash: "sha256:bound-request",
  requested_algorithm_name: "btc-daily-momentum",
  requested_symbol: "BTC",
  requested_asset_class: "crypto" as const,
  requested_interval: "1d",
  requested_start: "2026-07-13",
  requested_end: "2026-07-15",
}

describe("finny_dataset_evidence_finalize", () => {
  test("uses the requested regional exchange calendar for RELIANCE.NS", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-dsv2-regional-finalizer-"))
    roots.push(root)
    const dataRoot = path.join(root, "data")
    await fs.mkdir(path.join(dataRoot, "stock"), { recursive: true })
    const csvPath = "stock/RELIANCE.NS_1h_2026-07-13_2026-07-15.csv"
    await fs.writeFile(
      path.join(dataRoot, csvPath),
      [
        "timestamp,open,high,low,close,volume",
        "2026-07-13T03:45:00Z,100,105,99,104,1000",
        "2026-07-14T03:45:00Z,104,108,103,107,1200",
        "2026-07-15T03:45:00Z,107,110,106,109,900",
      ].join("\n"),
    )
    const result = await finalizeDatasetEvidenceFile({
      dataRoot,
      csvPath,
      request: {
        ...request,
        request_id: "request-reliance-hourly",
        requested_algorithm_name: "reliance-hourly",
        requested_symbol: "RELIANCE.NS",
        requested_asset_class: "equity",
        requested_interval: "1h",
      },
      workspaceSlug: "reliance-hourly.1.1.00.00",
      provider: { id: "yahoo", feed: "chart", venue: "NSE", providerSymbol: "RELIANCE.NS" },
      priceBasis: {
        basis: "adjusted" as const,
        split_treatment: "provider_adjusted",
        dividend_treatment: "provider_adjusted",
        corporate_action_status: "resolved",
        events: [],
      },
      now: new Date("2026-07-16T00:00:00Z"),
    })

    expect(result.manifest.calendar).toMatchObject({
      id: "REGIONAL_PROVIDER_OBSERVED",
      timezone: "Asia/Kolkata",
      session_type: "provider_observed",
    })
    expect(result.manifest.instrument.canonical_symbol).toBe("RELIANCE.NS")
    expect(result.manifest.qualification).toEqual({
      status: "research_only",
      reason_codes: ["REGIONAL_CALENDAR_PROVIDER_OBSERVED"],
    })
    expect(result.manifest.usable_for_parent).toBe("yes")
    expect(result.manifest.strict_backtest_eligible).toBe("no")
  })

  test("atomically creates the canonical sibling manifest and digest", async () => {
    const { dataRoot, csvPath } = await fixture()
    const result = await finalizeDatasetEvidenceFile({
      dataRoot,
      csvPath,
      request,
      workspaceSlug: "btc-daily-momentum.1.1.00.00",
      provider: { id: "binance", feed: "public-klines", venue: "BINANCE", providerSymbol: "BTCUSDT" },
      priceBasis: {
        basis: "raw",
        split_treatment: "not_applicable",
        dividend_treatment: "not_applicable",
        corporate_action_status: "not_applicable",
        events: [],
      },
      now: new Date("2026-07-16T00:00:00Z"),
    })

    expect(result.manifestPath).toBe(
      path.join(await fs.realpath(dataRoot), "crypto/BTC_1d_2026-07-13_2026-07-15.manifest.json"),
    )
    expect(JSON.parse(await fs.readFile(result.manifestPath, "utf8"))).toEqual(result.manifest)
    expect(result.digest).toContain(`artifact_paths: ${csvPath}, crypto/BTC_1d_2026-07-13_2026-07-15.manifest.json`)
    expect(result.digest).toContain("qualification")
    expect((await fs.readdir(path.dirname(result.manifestPath))).some((name) => name.endsWith(".tmp"))).toBe(false)
  })

  test("rejects absolute and escaping CSV paths", async () => {
    const { dataRoot, csvPath } = await fixture()
    const base = {
      dataRoot,
      request,
      workspaceSlug: "btc-daily-momentum.1.1.00.00",
      provider: { id: "binance", feed: "public-klines", venue: "BINANCE", providerSymbol: "BTCUSDT" },
      priceBasis: {
        basis: "raw" as const,
        split_treatment: "not_applicable",
        dividend_treatment: "not_applicable",
        corporate_action_status: "not_applicable" as const,
        events: [],
      },
    }
    await expect(finalizeDatasetEvidenceFile({ ...base, csvPath: path.join(dataRoot, csvPath) })).rejects.toThrow(
      "must be relative",
    )
    await expect(finalizeDatasetEvidenceFile({ ...base, csvPath: "../outside.csv" })).rejects.toThrow()
  })

  test("rejects a csv-named symlink whose resolved target is not csv", async () => {
    const { dataRoot } = await fixture()
    const target = path.join(dataRoot, "crypto", "payload.txt")
    const link = path.join(dataRoot, "crypto", "payload.csv")
    await fs.writeFile(target, "not a csv target")
    await fs.symlink(target, link)
    await expect(
      finalizeDatasetEvidenceFile({
        dataRoot,
        csvPath: "crypto/payload.csv",
        request,
        workspaceSlug: "btc-daily-momentum.1.1.00.00",
        provider: { id: "binance", feed: "public-klines", venue: "BINANCE", providerSymbol: "BTCUSDT" },
        priceBasis: {
          basis: "raw",
          split_treatment: "not_applicable",
          dividend_treatment: "not_applicable",
          corporate_action_status: "not_applicable",
          events: [],
        },
      }),
    ).rejects.toThrow("must resolve to a .csv file")
    expect(await fs.readFile(target, "utf8")).toBe("not a csv target")
  })
})
