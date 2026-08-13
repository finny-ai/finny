/**
 * Parser for LEAN backtest result JSON (BacktestResultPacket) produced by the
 * engine's BacktestingResultHandler: `{algorithmId}.json` plus the compact
 * `{algorithmId}-summary.json`.
 */
export interface LeanOrderRecord {
  orderId: string
  symbol: string
  type: string
  status: string
  direction: string
  quantity: number
  price: number | null
  tag: string
  time: string
}

export interface LeanFillRecord {
  orderId: string
  symbol: string
  direction: string
  quantity: number
  price: number
  fee: number
  time: string
  status: string
}

export interface LeanParsedResult {
  orders: LeanOrderRecord[]
  fills: LeanFillRecord[]
  rejections: LeanOrderRecord[]
  equityCurve: Array<{ timestamp: string; equity: number }>
  statistics: Record<string, unknown>
  raw: unknown
}

// OrderStatus enum values in the result packet.
const ORDER_STATUS = {
  New: 0,
  Submitted: 1,
  PartiallyFilled: 2,
  Filled: 3,
  Canceled: 4,
  None: 5,
  Invalid: 6,
  CancelPending: 7,
  UpdateSubmitted: 8,
} as const

function orderStatusCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
    const normalized = value.replaceAll(/[^a-z]/gi, "").toLowerCase()
    const entry = Object.entries(ORDER_STATUS).find(([name]) => name.toLowerCase() === normalized)
    return entry?.[1]
  }
  return undefined
}

function orderStatusName(value: unknown): string {
  const code = orderStatusCode(value)
  if (code !== undefined) {
    const entry = Object.entries(ORDER_STATUS).find(([, candidate]) => candidate === code)
    if (entry) return entry[0]
  }
  return String(value ?? "Unknown")
}

function orderDirection(value: unknown, quantity?: number): string {
  if (typeof value === "string" && /buy|sell/i.test(value)) return /sell/i.test(value) ? "Sell" : "Buy"
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric === 1 ? "Sell" : "Buy"
  return (quantity ?? 0) < 0 ? "Sell" : "Buy"
}

function finiteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function orderEventFee(event: Record<string, any>): number {
  return (
    finiteNumber(
      event?.orderFee?.value,
      event?.orderFee?.Value,
      event?.orderFee?.value?.amount,
      event?.orderFee?.value?.Amount,
      event?.orderFee?.Value?.amount,
      event?.orderFee?.Value?.Amount,
      event?.orderFee?.amount,
      event?.orderFee?.Amount,
    ) ?? 0
  )
}

function leanChartPoint(point: unknown): { timestamp: string; equity: number } | undefined {
  let x: unknown
  let y: unknown
  if (Array.isArray(point)) {
    x = point[0]
    // LEAN serializes line points as [epochSeconds, value] and candlesticks as
    // [epochSeconds, open, high, low, close]. Strategy Equity is a candlestick
    // series in real BacktestResultPacket output, so canonical NAV is the close.
    y = point.length >= 5 ? point[4] : point[1]
  } else if (point && typeof point === "object") {
    const record = point as Record<string, unknown>
    x = record.x ?? record.X
    const rawY = record.y ?? record.Y
    y = Array.isArray(rawY) ? rawY.at(-1) : rawY
  } else {
    return undefined
  }

  const equity = finiteNumber(y)
  if (equity === undefined) return undefined
  if (typeof x === "string" && !/^\d+(?:\.\d+)?$/.test(x.trim())) {
    const parsed = Date.parse(x)
    return Number.isFinite(parsed) ? { timestamp: new Date(parsed).toISOString(), equity } : undefined
  }
  const epoch = finiteNumber(x)
  if (epoch === undefined) return undefined
  // LEAN emits Unix seconds. Retain compatibility with older/test packets that
  // already contain epoch milliseconds without multiplying them a second time.
  const epochMs = Math.abs(epoch) < 100_000_000_000 ? epoch * 1000 : epoch
  const date = new Date(epochMs)
  if (!Number.isFinite(date.getTime())) return undefined
  return { timestamp: date.toISOString(), equity }
}

export function parseLeanResultJson(input: { text: string; summaryText?: string }): LeanParsedResult {
  const raw = JSON.parse(input.text) as Record<string, any>
  const ordersMap = (raw?.orders ?? {}) as Record<string, any>
  const events = (raw?.orderEvents ?? []) as Array<Record<string, any>>
  const orders: LeanOrderRecord[] = []
  const rejections: LeanOrderRecord[] = []
  const filledOrders: LeanOrderRecord[] = []
  const ordersById = new Map<string, LeanOrderRecord>()

  for (const [id, order] of Object.entries(ordersMap)) {
    const symbol = order?.symbol?.value ?? order?.symbol?.Value ?? String(order?.symbol ?? "")
    const statusCode = orderStatusCode(order?.status) ?? ORDER_STATUS.None
    const quantity = Number(order?.quantity ?? 0)
    const status = orderStatusName(order?.status)
    const record: LeanOrderRecord = {
      orderId: String(order?.orderId ?? id),
      symbol,
      type: String(order?.type ?? "Unknown"),
      status,
      direction: orderDirection(order?.direction, quantity),
      quantity,
      price: order?.price === undefined || order?.price === null ? null : Number(order.price),
      tag: String(order?.tag ?? ""),
      time: String(order?.time ?? ""),
    }
    ordersById.set(record.orderId, record)
    if (statusCode === ORDER_STATUS.Invalid || statusCode === ORDER_STATUS.Canceled || statusCode === ORDER_STATUS.CancelPending) {
      rejections.push(record)
    } else {
      orders.push(record)
      if (statusCode === ORDER_STATUS.Filled || statusCode === ORDER_STATUS.PartiallyFilled) {
        filledOrders.push(record)
      }
    }
  }

  const fills: LeanFillRecord[] = []
  const eventOrderIds = new Set<string>()
  for (const event of events) {
    const statusCode = orderStatusCode(event?.status)
    if (statusCode !== ORDER_STATUS.Filled && statusCode !== ORDER_STATUS.PartiallyFilled) continue
    const eventOrderId = String(event?.orderId ?? "")
    const quantity = Number(event?.fillQuantity ?? 0)
    const price = Number(event?.fillPrice ?? 0)
    if (!Number.isFinite(quantity) || !Number.isFinite(price) || quantity === 0 || price <= 0) continue
    const order = ordersById.get(eventOrderId)
    const symbol = event?.symbol?.value ?? event?.symbol?.Value ?? order?.symbol ?? ""
    fills.push({
      orderId: eventOrderId,
      symbol: String(symbol),
      direction: orderDirection(event?.direction, quantity),
      quantity,
      price,
      fee: orderEventFee(event),
      time: String(event?.utcTime ?? event?.time ?? order?.time ?? ""),
      status: orderStatusName(event?.status),
    })
    eventOrderIds.add(eventOrderId)
  }
  // Some local BacktestResultPacket variants omit orderEvents entirely. Only
  // reconstruct a final, fully-filled order in that case. A PartiallyFilled
  // order without events does not reveal its executed quantity and must not be
  // promoted into a fabricated full fill.
  for (const order of filledOrders) {
    if (eventOrderIds.has(order.orderId) || orderStatusCode(order.status) !== ORDER_STATUS.Filled) continue
    const quantity = Math.abs(order.quantity)
    const price = order.price
    if (quantity <= 0 || price === null || price <= 0) continue
    fills.push({
      orderId: order.orderId,
      symbol: order.symbol,
      direction: order.direction,
      quantity,
      price,
      fee: 0,
      time: order.time,
      status: "Filled",
    })
  }
  fills.sort((left, right) => {
    const leftTime = Date.parse(left.time)
    const rightTime = Date.parse(right.time)
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime
    return left.orderId.localeCompare(right.orderId, undefined, { numeric: true })
  })

  const equityCurve: Array<{ timestamp: string; equity: number }> = []
  const equitySeries =
    raw?.charts?.["Strategy Equity"]?.series?.Equity?.values ??
    raw?.charts?.Equity?.series?.Equity?.values ??
    []
  for (const point of equitySeries as unknown[]) {
    const parsed = leanChartPoint(point)
    if (parsed) equityCurve.push(parsed)
  }

  let statistics: Record<string, unknown> = {}
  try {
    const summary = JSON.parse(input.summaryText ?? "{}") as Record<string, any>
    statistics = summary?.statistics ?? summary?.Statistics ?? {}
  } catch {}

  return { orders, fills, rejections, equityCurve, statistics, raw }
}
