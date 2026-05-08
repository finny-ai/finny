import { describe, expect, test } from "bun:test"
import { Schedule } from "../../src/cron/schedule"

describe("Schedule.parse", () => {
  test("parses a 5-field cron expression as-is", () => {
    expect(Schedule.parse("30 9 * * 1-5")).toEqual({
      cron: "30 9 * * 1-5",
      marketAware: false,
      timezone: "America/New_York",
    })
  })

  test("expands @market_open alias to weekday 9:30 ET with marketAware=true", () => {
    expect(Schedule.parse("@market_open")).toEqual({
      cron: "30 9 * * 1-5",
      marketAware: true,
      timezone: "America/New_York",
    })
  })

  test("expands @market_close, @pre_market, @after_hours", () => {
    expect(Schedule.parse("@market_close").cron).toBe("0 16 * * 1-5")
    expect(Schedule.parse("@pre_market").cron).toBe("0 7 * * 1-5")
    expect(Schedule.parse("@after_hours").cron).toBe("30 16 * * 1-5")
  })

  test("respects custom timezone argument", () => {
    expect(Schedule.parse("0 12 * * *", "Europe/London").timezone).toBe("Europe/London")
  })

  test("rejects unknown aliases", () => {
    expect(() => Schedule.parse("@bogus")).toThrow(/unknown alias/)
  })

  test("rejects out-of-range fields", () => {
    expect(() => Schedule.parse("99 9 * * *")).toThrow()
    expect(() => Schedule.parse("0 25 * * *")).toThrow()
    expect(() => Schedule.parse("0 0 32 * *")).toThrow()
    expect(() => Schedule.parse("0 0 * 13 *")).toThrow()
    expect(() => Schedule.parse("0 0 * * 7")).toThrow()
  })

  test("rejects malformed expressions", () => {
    expect(() => Schedule.parse("not a cron")).toThrow()
    expect(() => Schedule.parse("* * *")).toThrow(/5 fields/)
    expect(() => Schedule.parse("* * * * * *")).toThrow(/5 fields/)
  })
})

describe("Schedule.matches", () => {
  // 2026-04-29 is a Wednesday. April is in DST so ET = UTC-4.
  const wed_0930_et = new Date("2026-04-29T13:30:00Z")
  const wed_0931_et = new Date("2026-04-29T13:31:00Z")
  const sat_0930_et = new Date("2026-05-02T13:30:00Z")
  const tz = "America/New_York"

  test("matches exact minute on a weekday", () => {
    expect(Schedule.matches("30 9 * * 1-5", wed_0930_et, tz)).toBe(true)
  })

  test("does not match adjacent minute", () => {
    expect(Schedule.matches("30 9 * * 1-5", wed_0931_et, tz)).toBe(false)
  })

  test("excludes weekend when day-of-week range is 1-5", () => {
    expect(Schedule.matches("30 9 * * 1-5", sat_0930_et, tz)).toBe(false)
  })

  test("step expression matches every-15-minute schedule", () => {
    expect(Schedule.matches("*/15 * * * *", new Date("2026-04-29T13:00:00Z"), "UTC")).toBe(true)
    expect(Schedule.matches("*/15 * * * *", new Date("2026-04-29T13:07:00Z"), "UTC")).toBe(false)
    expect(Schedule.matches("*/15 * * * *", new Date("2026-04-29T13:15:00Z"), "UTC")).toBe(true)
    expect(Schedule.matches("*/15 * * * *", new Date("2026-04-29T13:30:00Z"), "UTC")).toBe(true)
  })

  test("comma list matches each listed value", () => {
    expect(Schedule.matches("0,30 9 * * *", new Date("2026-04-29T09:00:00Z"), "UTC")).toBe(true)
    expect(Schedule.matches("0,30 9 * * *", new Date("2026-04-29T09:15:00Z"), "UTC")).toBe(false)
    expect(Schedule.matches("0,30 9 * * *", new Date("2026-04-29T09:30:00Z"), "UTC")).toBe(true)
  })

  test("range matches inclusive bounds", () => {
    expect(Schedule.matches("0 9-11 * * *", new Date("2026-04-29T09:00:00Z"), "UTC")).toBe(true)
    expect(Schedule.matches("0 9-11 * * *", new Date("2026-04-29T11:00:00Z"), "UTC")).toBe(true)
    expect(Schedule.matches("0 9-11 * * *", new Date("2026-04-29T12:00:00Z"), "UTC")).toBe(false)
  })

  test("timezone shift correctly rotates the matching hour", () => {
    // 13:30 UTC on 2026-04-29 is 09:30 in America/New_York (EDT) but 06:30 in
    // America/Los_Angeles. A "30 9 * * *" schedule should match in NY tz, not LA tz.
    const t = new Date("2026-04-29T13:30:00Z")
    expect(Schedule.matches("30 9 * * *", t, "America/New_York")).toBe(true)
    expect(Schedule.matches("30 9 * * *", t, "America/Los_Angeles")).toBe(false)
  })

  test("Sunday matches dow=0", () => {
    // 2026-04-26 is a Sunday.
    const sun_noon_utc = new Date("2026-04-26T12:00:00Z")
    expect(Schedule.matches("0 12 * * 0", sun_noon_utc, "UTC")).toBe(true)
    expect(Schedule.matches("0 12 * * 1-5", sun_noon_utc, "UTC")).toBe(false)
  })

  test("malformed cron returns false rather than throwing", () => {
    expect(Schedule.matches("not a cron", new Date(), "UTC")).toBe(false)
    expect(Schedule.matches("* * *", new Date(), "UTC")).toBe(false)
  })
})

describe("Schedule.estimateRunsPerHour", () => {
  test("estimates common every-minute cadences", () => {
    expect(Schedule.estimateRunsPerHour("*/15 * * * *")).toBe(4)
    expect(Schedule.estimateRunsPerHour("0 * * * *")).toBe(1)
    expect(Schedule.estimateRunsPerHour("*/5 * * * *")).toBe(12)
  })

  test("scales restricted hour windows", () => {
    expect(Schedule.estimateRunsPerHour("0 9-16 * * 1-5")).toBeCloseTo((8 * 5) / (24 * 7))
  })

  test("malformed cron estimates as zero", () => {
    expect(Schedule.estimateRunsPerHour("not a cron")).toBe(0)
  })
})
