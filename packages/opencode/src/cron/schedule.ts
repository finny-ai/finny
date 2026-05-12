export namespace Schedule {
  /**
   * Minimal 5-field cron parser: minute hour day-of-month month day-of-week
   * Supports: *, comma-lists, ranges (a-b), step (* /n, a-b/n), single values.
   * No seconds. No L/W/#. Good enough for v1.
   *
   * Market aliases — recognised at parse time and expanded to a weekday-only
   * cron expression. The marketAware flag is set so the scheduler can later
   * skip NYSE holidays via a calendar wrapper. As of this commit the calendar
   * wrapper is not yet wired, so jobs using these aliases fire on every weekday
   * (ignoring market holidays):
   *   @market_open   → 30 9 * * 1-5    (NYSE 9:30 ET, weekday)
   *   @market_close  → 0 16 * * 1-5    (NYSE 16:00 ET, weekday)
   *   @pre_market    → 0 7 * * 1-5     (07:00 ET, weekday)
   *   @after_hours   → 30 16 * * 1-5   (16:30 ET, weekday)
   */
  export type Parsed = {
    cron: string
    marketAware: boolean
    timezone: string
  }

  const MARKET_ALIASES: Record<string, string> = {
    "@market_open": "30 9 * * 1-5",
    "@market_close": "0 16 * * 1-5",
    "@pre_market": "0 7 * * 1-5",
    "@after_hours": "30 16 * * 1-5",
  }

  export function parse(input: string, timezone = "America/New_York"): Parsed {
    const trimmed = input.trim()
    if (trimmed.startsWith("@")) {
      const expanded = MARKET_ALIASES[trimmed]
      if (!expanded) throw new Error(`unknown alias: ${trimmed}`)
      return { cron: expanded, marketAware: true, timezone }
    }
    validate(trimmed)
    return { cron: trimmed, marketAware: false, timezone }
  }

  function validate(expr: string) {
    const fields = expr.split(/\s+/)
    if (fields.length !== 5) throw new Error(`cron must have 5 fields, got ${fields.length}: "${expr}"`)
    const ranges: [number, number][] = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 6],
    ]
    fields.forEach((f, i) => parseField(f, ranges[i]![0], ranges[i]![1]))
  }

  function parseField(field: string, lo: number, hi: number): Set<number> {
    const out = new Set<number>()
    for (const part of field.split(",")) {
      let stepStr = "1"
      let rangeStr = part
      if (part.includes("/")) [rangeStr, stepStr] = part.split("/", 2) as [string, string]
      const step = parseInt(stepStr, 10)
      if (!Number.isFinite(step) || step <= 0) throw new Error(`invalid step in "${field}"`)
      let start: number, end: number
      if (rangeStr === "*") {
        start = lo
        end = hi
      } else if (rangeStr.includes("-")) {
        const [a, b] = rangeStr.split("-", 2) as [string, string]
        start = parseInt(a, 10)
        end = parseInt(b, 10)
      } else {
        start = end = parseInt(rangeStr, 10)
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < lo || end > hi || start > end) {
        throw new Error(`invalid field "${field}" (allowed ${lo}-${hi})`)
      }
      for (let v = start; v <= end; v += step) out.add(v)
    }
    return out
  }

  /**
   * True if the cron expression matches the given Date in the target tz.
   * Returns false (rather than throwing) on malformed input so a single
   * corrupt job entry can't crash a whole scheduler tick.
   */
  export function matches(cron: string, when: Date, timezone: string): boolean {
    const fields = cron.split(/\s+/)
    if (fields.length !== 5) return false
    const ranges: [number, number][] = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 6],
    ]
    try {
      const sets = fields.map((f, i) => parseField(f, ranges[i]![0], ranges[i]![1]))
      const parts = parts_in_tz(when, timezone)
      return (
        sets[0]!.has(parts.minute) &&
        sets[1]!.has(parts.hour) &&
        sets[2]!.has(parts.day) &&
        sets[3]!.has(parts.month) &&
        sets[4]!.has(parts.weekday)
      )
    } catch {
      return false
    }
  }

  export function estimateRunsPerHour(cron: string): number {
    const fields = cron.split(/\s+/)
    if (fields.length !== 5) return 0
    const ranges: [number, number][] = [
      [0, 59],
      [0, 23],
      [1, 31],
      [1, 12],
      [0, 6],
    ]
    try {
      const minutes = parseField(fields[0]!, ranges[0]![0], ranges[0]![1])
      const hours = parseField(fields[1]!, ranges[1]![0], ranges[1]![1])
      const days = parseField(fields[2]!, ranges[2]![0], ranges[2]![1])
      const months = parseField(fields[3]!, ranges[3]![0], ranges[3]![1])
      const weekdays = parseField(fields[4]!, ranges[4]![0], ranges[4]![1])
      return (minutes.size * hours.size * Math.min(1, days.size / 31) * Math.min(1, months.size / 12) * Math.min(1, weekdays.size / 7)) / 24
    } catch {
      return 0
    }
  }

  function parts_in_tz(date: Date, timezone: string) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    })
    const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    return {
      minute: parseInt(parts.minute!, 10),
      hour: parseInt(parts.hour === "24" ? "0" : parts.hour!, 10),
      day: parseInt(parts.day!, 10),
      month: parseInt(parts.month!, 10),
      weekday: weekdayMap[parts.weekday!] ?? 0,
    }
  }
}
