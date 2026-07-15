import { describe, expect, test } from "bun:test"
import { promptFromParams, workspacePrepareIdentityConflict } from "../../src/tool/workspace-prepare"
import { findLatestReviewPacketInRoots } from "../../src/tool/review-packet"
import { parseRequestFacts } from "../../src/agent/request-identity"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

describe("workspace prepare request context", () => {
  test("puts structured dates before summary dates", () => {
    const prompt = promptFromParams(
      {
        requestSummary: "Earlier context mentions 2023-01-01 and 2023-06-01.",
        startDate: "2024-07-10",
        endDate: "2026-07-10",
      },
      "",
    )
    expect(prompt.startsWith("date window 2024-07-10 to 2026-07-10")).toBe(true)
  })

  test("keeps structured SPY identity ahead of SMA(200) prose", () => {
    const prompt = promptFromParams(
      {
        requestSummary: "Build a named SMA(200) strategy; older notes called this a 200d setup.",
        algorithmName: "spy-sma-200",
        symbol: "SPY",
        assetClass: "equity",
        interval: "1d",
        startDate: "2018-01-01",
        endDate: "2025-12-31",
      },
      "",
    )
    expect(parseRequestFacts(prompt)).toMatchObject({
      requested_symbol: "SPY",
      requested_interval: "1d",
      requested_asset_class: "equity",
    })
    expect(prompt.startsWith("algorithm spy-sma-200; symbol SPY; asset class equity; interval 1d")).toBe(true)
    expect(prompt.indexOf("2018-01-01")).toBeLessThan(prompt.indexOf("200d"))
  })

  test("rejects a proxy symbol that conflicts with the latest user request", () => {
    const result = workspacePrepareIdentityConflict(
      { symbol: "VOO", assetClass: "equity", interval: "15min" },
      "VFV 15min",
    )
    expect(result).toContain("symbol VOO conflicts with the user's VFV")
    expect(result).toContain("Do not substitute a proxy ticker")
  })

  test("accepts normalized spelling of the user's exact identity", () => {
    expect(
      workspacePrepareIdentityConflict(
        { symbol: "VFV", assetClass: "equity", interval: "15m" },
        "Build a VFV 15-minute strategy",
      ),
    ).toBeUndefined()
  })
})

describe("existing review packet lookup", () => {
  test("finds the newest packet without requiring an experiment id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "finny-review-lookup-"))
    try {
      const store = path.join(root, "algorithms", "algo-review")
      const older = path.join(store, "reviews", "exp-old", "review.html")
      const latest = path.join(store, "reviews", "exp-latest", "review.html")
      await fs.mkdir(path.dirname(older), { recursive: true })
      await fs.mkdir(path.dirname(latest), { recursive: true })
      await fs.writeFile(older, "older")
      await fs.writeFile(latest, "latest")
      const now = new Date()
      await fs.utimes(older, new Date(now.getTime() - 10_000), new Date(now.getTime() - 10_000))
      expect(await findLatestReviewPacketInRoots([store])).toBe(latest)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
