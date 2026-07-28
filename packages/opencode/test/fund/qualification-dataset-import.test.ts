import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { importQualificationDatasetV1 } from "../../src/fund/qualification-dataset-import"
import { requireVerifiedDataExtractorEvidenceForSession } from "../../src/data/data-extractor-evidence"

const roots: string[] = []
const originalFinnyHome = process.env.FINNY_HOME

afterEach(async () => {
  if (originalFinnyHome === undefined) delete process.env.FINNY_HOME
  else process.env.FINNY_HOME = originalFinnyHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

describe("fund qualification dataset import", () => {
  test("binds exact request identity and produces strict runtime evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-fund-dataset-import-"))
    roots.push(root)
    process.env.FINNY_HOME = root
    const csv = [
      "timestamp,open,high,low,close,volume",
      "2026-07-13T00:00:00Z,100,105,99,104,1000",
      "2026-07-14T00:00:00Z,104,108,103,107,1200",
      "2026-07-15T00:00:00Z,107,110,106,109,900",
    ].join("\n")
    const result = await importQualificationDatasetV1({
      sessionId: "ses-fund-qualification-1",
      algorithmName: "btc-daily-fund-candidate",
      symbol: "BTC",
      assetClass: "crypto",
      interval: "1d",
      requestedStart: "2026-07-13",
      requestedEnd: "2026-07-15",
      csvBase64: Buffer.from(csv).toString("base64"),
      csvSha256: sha256(csv),
      providerId: "binance",
      providerFeed: "production-usdm-klines",
      providerVenue: "BINANCE",
      providerSymbol: "BTCUSDT",
      priceBasis: "raw",
      splitTreatment: "not_applicable",
      dividendTreatment: "not_applicable",
      corporateActionStatus: "not_applicable",
    })

    expect(result.qualification).toBe("strict_qualified")
    expect(result.csvSha256).toBe(sha256(csv))
    expect(result.requestContentHash.startsWith("sha256:")).toBe(true)
    const evidence = await requireVerifiedDataExtractorEvidenceForSession(result.sessionId)
    expect(evidence.ok).toBe(true)
    expect(evidence.dataset?.csvSha256).toBe(result.csvSha256)
  })

  test("rejects a content hash mismatch before creating a workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-fund-dataset-reject-"))
    roots.push(root)
    process.env.FINNY_HOME = root
    const csv = "timestamp,open,high,low,close,volume\n"
    await expect(
      importQualificationDatasetV1({
        sessionId: "ses-fund-qualification-2",
        algorithmName: "btc-rejected-candidate",
        symbol: "BTC",
        assetClass: "crypto",
        interval: "1d",
        requestedStart: "2026-07-13",
        requestedEnd: "2026-07-15",
        csvBase64: Buffer.from(csv).toString("base64"),
        csvSha256: "0".repeat(64),
        providerId: "binance",
        providerFeed: "production-usdm-klines",
        providerVenue: "BINANCE",
        providerSymbol: "BTCUSDT",
        priceBasis: "raw",
        splitTreatment: "not_applicable",
        dividendTreatment: "not_applicable",
        corporateActionStatus: "not_applicable",
      }),
    ).rejects.toThrow("content hash mismatch")
    await expect(fs.readdir(path.join(root, "algos"))).rejects.toThrow()
  })
})

