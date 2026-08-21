export const DATASET_CALENDAR_VERSION = "finny-calendars-2026.1" as const

export type EvidenceCalendarRequest = {
  calendarId: string
  sessionType: string
  interval: string
  requestedStartInclusive: string
  requestedEndInclusive: string
}

type CalendarContext = { request: EvidenceCalendarRequest; step: number; days: string[] }
type EpochInput = { epoch: number }
type DayInput = { day: string }
type YearInput = { year: number }
type DayOffset = DayInput & { count: number }
type ZonedTime = DayInput & { hour: number; minute?: number }
type TimestampRange = { start: number; endExclusive: number; step: number }
type SessionInput = { days: string[]; step: number; sessionType?: string }

const DAY = 86_400_000
const NEW_YORK = "America/New_York"

function intervalMilliseconds(input: { interval: string }): number | undefined {
  const match = input.interval
    .trim()
    .toLowerCase()
    .match(/^(\d+)(m|min|h|d)$/)
  if (!match) return undefined
  const value = Number(match[1])
  const multipliers: Record<string, number> = { d: DAY, h: 3_600_000, m: 60_000, min: 60_000 }
  return value * multipliers[match[2]]
}

function isoDay(input: EpochInput): string {
  return new Date(input.epoch).toISOString().slice(0, 10)
}

function dayEpoch(input: DayInput): number {
  const match = input.day.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN
}

function addDays(input: DayOffset): string {
  return isoDay({ epoch: dayEpoch(input) + input.count * DAY })
}

function partsInNewYork(input: EpochInput): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NEW_YORK,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(input.epoch)
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]),
  )
}

function zonedEpoch(input: ZonedTime): number {
  const [year, month, date] = input.day.split("-").map(Number)
  const desired = Date.UTC(year, month - 1, date, input.hour, input.minute ?? 0)
  let epoch = desired
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = partsInNewYork({ epoch })
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    epoch += desired - represented
  }
  return epoch
}

function observedHoliday(input: { year: number; month: number; day: number }): string {
  const epoch = Date.UTC(input.year, input.month - 1, input.day)
  const weekday = new Date(epoch).getUTCDay()
  const shift = weekday === 6 ? -DAY : weekday === 0 ? DAY : 0
  return isoDay({ epoch: epoch + shift })
}

function nthWeekday(input: { year: number; month: number; weekday: number; occurrence: number }): string {
  if (input.occurrence > 0) {
    const first = Date.UTC(input.year, input.month - 1, 1)
    const offset = (input.weekday - new Date(first).getUTCDay() + 7) % 7
    return isoDay({ epoch: first + (offset + 7 * (input.occurrence - 1)) * DAY })
  }
  const last = Date.UTC(input.year, input.month, 0)
  const offset = (new Date(last).getUTCDay() - input.weekday + 7) % 7
  return isoDay({ epoch: last - offset * DAY })
}

function easter(input: YearInput): string {
  const a = input.year % 19
  const b = Math.floor(input.year / 100)
  const c = input.year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return isoDay({ epoch: Date.UTC(input.year, month - 1, day) })
}

function thanksgiving(input: YearInput): string {
  return nthWeekday({ year: input.year, month: 11, weekday: 4, occurrence: 4 })
}

function nyseHolidays(input: YearInput): Set<string> {
  const fixed = [
    [1, 1],
    [6, 19],
    [7, 4],
    [12, 25],
  ].map(([month, day]) => observedHoliday({ year: input.year, month, day }))
  return new Set([
    ...fixed,
    nthWeekday({ year: input.year, month: 1, weekday: 1, occurrence: 3 }),
    nthWeekday({ year: input.year, month: 2, weekday: 1, occurrence: 3 }),
    nthWeekday({ year: input.year, month: 5, weekday: 1, occurrence: -1 }),
    nthWeekday({ year: input.year, month: 9, weekday: 1, occurrence: 1 }),
    thanksgiving(input),
    addDays({ day: easter(input), count: -2 }),
  ])
}

function isNyseTradingDay(input: DayInput): boolean {
  const epoch = dayEpoch(input)
  const weekday = new Date(epoch).getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const year = Number(input.day.slice(0, 4))
  return ![year - 1, year, year + 1].some((candidate) => nyseHolidays({ year: candidate }).has(input.day))
}

function isNyseHalfDay(input: DayInput): boolean {
  if (!isNyseTradingDay(input)) return false
  const year = Number(input.day.slice(0, 4))
  const fixed = new Set([addDays({ day: thanksgiving({ year }), count: 1 }), `${year}-12-24`, `${year}-07-03`])
  if (fixed.has(input.day)) return true
  const julyFourthSunday = new Date(Date.UTC(year, 6, 4)).getUTCDay() === 0
  return julyFourthSunday && input.day === `${year}-07-02`
}

function newYorkDay(input: EpochInput): string {
  const parts = partsInNewYork(input)
  const month = String(parts.month).padStart(2, "0")
  const day = String(parts.day).padStart(2, "0")
  return `${parts.year}-${month}-${day}`
}

/**
 * Last XNYS session whose regular-hours close is available to a delayed
 * historical-data entitlement. Date-only evidence windows must use a fully
 * closed session; otherwise the finalizer correctly sees the rest of today's
 * 09:30-16:00 session as missing data.
 */
export function lastCompletedXnysSessionDate(input: { now: Date; availabilityDelayMinutes?: number }): string {
  const nowEpoch = input.now.getTime()
  const delay = (input.availabilityDelayMinutes ?? 15) * 60_000
  let candidate = newYorkDay({ epoch: nowEpoch })

  if (isNyseTradingDay({ day: candidate })) {
    const closeHour = isNyseHalfDay({ day: candidate }) ? 13 : 16
    const availableAt = zonedEpoch({ day: candidate, hour: closeHour }) + delay
    if (nowEpoch >= availableAt) return candidate
  }

  candidate = addDays({ day: candidate, count: -1 })
  while (!isNyseTradingDay({ day: candidate })) {
    candidate = addDays({ day: candidate, count: -1 })
  }
  return candidate
}

function timestamps(input: TimestampRange): number[] {
  const values: number[] = []
  for (let value = input.start; value < input.endExclusive; value += input.step) values.push(value)
  return values
}

function calendarDays(input: { start: string; end: string }): string[] {
  const values: string[] = []
  for (let cursor = dayEpoch({ day: input.start }); cursor <= dayEpoch({ day: input.end }); cursor += DAY) {
    values.push(isoDay({ epoch: cursor }))
  }
  return values
}

function nyseExpected(input: SessionInput): number[] {
  return input.days.flatMap((day) => {
    if (!isNyseTradingDay({ day })) return []
    if (input.step >= DAY) return [dayEpoch({ day })]
    const extended = input.sessionType === "extended"
    const open = extended ? 4 : 9.5
    const close = extended ? 20 : isNyseHalfDay({ day }) ? 13 : 16
    return timestamps({
      start: zonedEpoch({ day, hour: Math.floor(open), minute: (open % 1) * 60 }),
      endExclusive: zonedEpoch({ day, hour: close }),
      step: input.step,
    })
  })
}

function futuresExpected(input: SessionInput): number[] {
  return input.days.flatMap((tradeDay) => {
    const weekday = new Date(dayEpoch({ day: tradeDay })).getUTCDay()
    if (weekday === 0 || weekday === 6) return []
    if (input.step >= DAY) return [dayEpoch({ day: tradeDay })]
    return timestamps({
      start: zonedEpoch({ day: addDays({ day: tradeDay, count: -1 }), hour: 18 }),
      endExclusive: zonedEpoch({ day: tradeDay, hour: 17 }),
      step: input.step,
    })
  })
}

function continuousExpected(input: SessionInput): number[] {
  return timestamps({
    start: dayEpoch({ day: input.days[0] }),
    endExclusive: dayEpoch({ day: input.days.at(-1)! }) + DAY,
    step: input.step,
  })
}

function fxExpected(input: SessionInput): number[] {
  return continuousExpected(input).filter((epoch) => {
    const local = partsInNewYork({ epoch })
    const weekday = new Date(Date.UTC(local.year, local.month - 1, local.day)).getUTCDay()
    const weekdaySession = weekday >= 1 && weekday <= 4
    return weekdaySession || (weekday === 5 && local.hour < 17) || (weekday === 0 && local.hour >= 17)
  })
}

function requestedDay(input: { value: string }): string {
  const day = input.value.slice(0, 10)
  if (!Number.isFinite(dayEpoch({ day }))) throw new Error("invalid requested evidence window")
  return day
}

function requestedDays(request: EvidenceCalendarRequest): { start: string; end: string } {
  const start = requestedDay({ value: request.requestedStartInclusive })
  const end = requestedDay({ value: request.requestedEndInclusive })
  if (end < start) throw new Error("invalid requested evidence window")
  return { start, end }
}

function calendarContext(request: EvidenceCalendarRequest): CalendarContext {
  const step = intervalMilliseconds({ interval: request.interval })
  if (!step) throw new Error(`unsupported strict interval: ${request.interval}`)
  return { request, step, days: calendarDays(requestedDays(request)) }
}

function generateCalendar(context: CalendarContext): number[] {
  const input = { days: context.days, step: context.step, sessionType: context.request.sessionType }
  const generators: Record<string, () => number[]> = {
    XNYS: () => nyseExpected(input),
    CMES: () => futuresExpected(input),
    "24/7": () => continuousExpected(input),
    FX_24_5: () => fxExpected(input),
  }
  const generator = generators[context.request.calendarId]
  if (!generator) throw new Error(`unsupported strict calendar: ${context.request.calendarId}`)
  return generator()
}

function boundToRequestedWindow(input: { generated: number[]; request: EvidenceCalendarRequest }): number[] {
  const timestampBounded =
    input.request.requestedStartInclusive.length > 10 || input.request.requestedEndInclusive.length > 10
  if (!timestampBounded) return input.generated
  const lower = Date.parse(input.request.requestedStartInclusive)
  const upper = Date.parse(input.request.requestedEndInclusive)
  if (!Number.isFinite(lower)) throw new Error("invalid requested evidence window")
  if (!Number.isFinite(upper)) throw new Error("invalid requested evidence window")
  return input.generated.filter((value) => value >= lower && value <= upper)
}

export function expectedEvidenceTimestamps(request: EvidenceCalendarRequest): number[] {
  const context = calendarContext(request)
  return boundToRequestedWindow({ generated: generateCalendar(context), request })
}

/**
 * Map provider bar timestamps onto the timestamp convention used by the
 * evidence calendar. Daily XNYS feeds commonly label a bar at local midnight
 * (04:00Z or 05:00Z depending on DST), while Finny represents the same trading
 * session as 00:00Z on its calendar date. They are the same session, not a
 * missing bar plus an extra bar.
 *
 * A bar already stamped at exact UTC midnight is date-only (`YYYY-MM-DD`) or
 * explicitly UTC, which is the calendar's own convention, so it is returned
 * unchanged. Re-projecting it through New York would move every session back
 * one calendar day and report the whole window as missing plus extra.
 */
export function canonicalEvidenceTimestamp(input: {
  calendarId: string
  interval: string
  timestamp: number
}): number {
  const step = intervalMilliseconds({ interval: input.interval })
  if (input.calendarId !== "XNYS" || step === undefined || step < DAY) return input.timestamp
  if (Number.isFinite(input.timestamp) && ((input.timestamp % DAY) + DAY) % DAY === 0) return input.timestamp
  return dayEpoch({ day: newYorkDay({ epoch: input.timestamp }) })
}
