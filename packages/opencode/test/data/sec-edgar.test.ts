import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import {
  matchReportingOwners,
  parse13FHoldings,
  parseForm4Transactions,
  parseSecRequestContext,
  resolveTickerToCik,
  type CompanyTickersIndex,
} from "../../src/data/sec-edgar"

const FIXTURES = path.join(import.meta.dir, "../fixtures/sec")

async function loadFixture(name: string) {
  return fs.readFile(path.join(FIXTURES, name), "utf8")
}

describe("sec-edgar parsers", () => {
  test("resolves ticker and company name to CIK", async () => {
    const raw = await loadFixture("company_tickers.json")
    const index = JSON.parse(raw) as CompanyTickersIndex

    const byTicker = resolveTickerToCik(index, "MSFT")
    expect(byTicker?.cik).toBe("0000789019")
    expect(byTicker?.ticker).toBe("MSFT")
    expect(byTicker?.secUrl).toContain("CIK=0000789019")

    const byName = resolveTickerToCik(index, "Microsoft")
    expect(byName?.ticker).toBe("MSFT")
    expect(byName?.cik).toBe("0000789019")

    expect(resolveTickerToCik(index, "NOTREAL")).toBeUndefined()
  })

  test("extracts Form 4 insider transactions", async () => {
    const xml = await loadFixture("form4_msft_gates.xml")
    const parsed = parseForm4Transactions(xml)

    expect(parsed.issuerTicker).toBe("MSFT")
    expect(parsed.transactions).toHaveLength(1)
    expect(parsed.transactions[0]).toMatchObject({
      reportingOwner: "Gates William H III",
      transactionDate: "2024-02-02",
      transactionCode: "S",
      shares: 22000,
      pricePerShare: 403.5,
      sharesOwnedFollowing: 1025000,
    })
  })

  test("extracts 13F institutional holdings", async () => {
    const raw = await loadFixture("form13f_holdings.json")
    const parsed = parse13FHoldings(JSON.parse(raw))

    expect(parsed.managerName).toBe("BERKSHIRE HATHAWAY INC")
    expect(parsed.holdings).toHaveLength(2)
    expect(parsed.holdings[0]?.issuerName).toBe("APPLE INC")
    expect(parsed.holdings[1]?.shares).toBe(75000000)
  })

  test("flags ambiguous reporting-owner name matches", () => {
    const owners = [
      { name: "Smith John", cik: "0001214128" },
      { name: "Smith John A", cik: "0009999999" },
    ]
    const { matches, ambiguous } = matchReportingOwners(owners, "John Smith")
    expect(matches.length).toBeGreaterThan(0)
    expect(ambiguous).toBe(true)
  })

  test("parseSecRequestContext extracts company, person, and dates", () => {
    const ctx = parseSecRequestContext(
      "Did Bill Gates sell Microsoft stock between 2024-01-01 and 2024-03-31?",
    )
    expect(ctx.requested_person).toBe("Bill Gates")
    expect(ctx.requested_company_or_ticker?.toLowerCase()).toContain("microsoft")
    expect(ctx.date_start).toBe("2024-01-01")
    expect(ctx.date_end).toBe("2024-03-31")
  })
})
