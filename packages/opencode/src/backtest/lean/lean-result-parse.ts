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

export function parseLeanResultJson(input: { text: string; summaryText?: string }): LeanParsedResult {
  const raw = JSON.parse(input.text) as Record<string, any>
  const ordersMap = (raw?.orders ?? {}) as Record<string, any>
  const events = (raw?.orderEvents ?? []) as Array<Record<string, any>>
  const orders: LeanOrderRecord[] = []
  const rejections: LeanOrderRecord[] = []
  const filledOrders: LeanOrderRecord[] = []

  for (const [id, order] of Object.entries(ordersMap)) {
    const symbol = order?.symbol?.value ?? order?.symbol?.Value ?? String(order?.symbol ?? "")
    const statusCode = Number(order?.status ?? ORDER_STATUS.None)
    const direction = Number(order?.direction ?? 0)
    const status = String(statusCode)
    const record: LeanOrderRecord = {
      orderId: String(order?.orderId ?? id),
      symbol,
      type: String(order?.type ?? "Unknown"),
      status,
      direction: direction === 1 ? "Sell" : "Buy",
      quantity: Number(order?.quantity ?? 0),
      price: order?.price === undefined || order?.price === null ? null : Number(order.price),
      tag: String(order?.tag ?? ""),
      time: String(order?.time ?? ""),
    }
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
  const filledOrderIds = new Set<string>()
  for (const order of filledOrders) {
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
    filledOrderIds.add(order.orderId)
  }
  for (const event of events) {
    const status = String(event?.status ?? "")
    if (!/filled/i.test(status)) continue
    const eventOrderId = String(event?.orderId ?? "")
    if (filledOrderIds.has(eventOrderId)) continue
    const quantity = Number(event?.fillQuantity ?? 0)
    const price = Number(event?.fillPrice ?? 0)
    if (!Number.isFinite(quantity) || !Number.isFinite(price) || quantity === 0) continue
    const fee = Number(event?.orderFee?.value ?? event?.orderFee?.Value ?? 0)
    const symbol = event?.symbol?.value ?? event?.symbol?.Value ?? ""
    fills.push({
      orderId: String(event?.orderId ?? ""),
      symbol: String(symbol),
      direction: String(event?.direction ?? ""),
      quantity,
      price,
      fee: Number.isFinite(fee) ? fee : 0,
      time: String(event?.time ?? ""),
      status,
    })
  }

  const equityCurve: Array<{ timestamp: string; equity: number }> = []
  const equitySeries =
    raw?.charts?.["Strategy Equity"]?.series?.Equity?.values ??
    raw?.charts?.Equity?.series?.Equity?.values ??
    []
  for (const point of equitySeries as Array<{ x: number; y: number }>) {
    const x = Number(point?.x)
    const y = Number(point?.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    equityCurve.push({ timestamp: new Date(x).toISOString(), equity: y })
  }

  let statistics: Record<string, unknown> = {}
  try {
    const summary = JSON.parse(input.summaryText ?? "{}") as Record<string, any>
    statistics = summary?.statistics ?? summary?.Statistics ?? {}
  } catch {}

  return { orders, fills, rejections, equityCurve, statistics, raw }
}
