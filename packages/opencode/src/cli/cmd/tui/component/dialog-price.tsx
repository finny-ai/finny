import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, Show, For, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { TuiEvent } from "../event"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

const CRYPTO_SYMBOLS = ["BTC", "ETH", "SOL"]
const CRYPTO_COLOR = "#F7931A" // Bitcoin orange

interface PriceData {
  symbol: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  timestamp?: number
  // Extra stock data
  marketCap?: number
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
  previousClose?: number
  pe?: number
}

export function DialogPrice() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()

  const [prices, setPrices] = createSignal<Record<string, PriceData>>({})
  const [selected, setSelected] = createSignal(0)
  const [initialLoading, setInitialLoading] = createSignal(true)
  const [refreshing, setRefreshing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [lastUpdate, setLastUpdate] = createSignal<Date | null>(null)
  const [detailView, setDetailView] = createSignal<PriceData | null>(null)

  const isCrypto = (symbol: string) => CRYPTO_SYMBOLS.includes(symbol)

  async function fetchPrices(manual = false) {
    if (manual) setRefreshing(true)
    try {
      const response = await fetch(`${SIMULATOR_URL}/prices`)
      const data = await response.json()
      setPrices(data.prices || {})
      setError(null)
      setLastUpdate(new Date())
    } catch {
      // Only show error if we have no data yet
      if (Object.keys(prices()).length === 0) {
        setError("Cannot connect to simulator")
      }
    }
    setInitialLoading(false)
    if (manual) {
      // Brief flash to show refresh happened
      setTimeout(() => setRefreshing(false), 300)
    }
  }

  onMount(() => {
    fetchPrices(false)
    // Refresh every 2 seconds (no flicker since we keep old data)
    const interval = setInterval(() => fetchPrices(false), 2000)
    return () => clearInterval(interval)
  })

  // Separate stocks and crypto, stocks first
  const stockList = () => Object.entries(prices()).filter(([s]) => !isCrypto(s))
  const cryptoList = () => Object.entries(prices()).filter(([s]) => isCrypto(s))
  const priceList = () => [...stockList(), ...cryptoList()]
  const totalCount = () => priceList().length

  const insertToChat = (data: PriceData) => {
    const change = data.close - data.open
    const changePercent = data.open ? ((change / data.open) * 100) : 0

    let text = `${data.symbol} | Price: $${data.close?.toFixed(2)} (${change >= 0 ? "+" : ""}${changePercent.toFixed(2)}%) | Open: $${data.open?.toFixed(2)} | High: $${data.high?.toFixed(2)} | Low: $${data.low?.toFixed(2)} | Volume: ${formatVolume(data.volume ?? 0)}`

    // Add extra stock data if available
    if (!isCrypto(data.symbol)) {
      if (data.marketCap) text += ` | Market Cap: ${formatMarketCap(data.marketCap)}`
      if (data.fiftyTwoWeekHigh) text += ` | 52W High: $${data.fiftyTwoWeekHigh.toFixed(2)}`
      if (data.fiftyTwoWeekLow) text += ` | 52W Low: $${data.fiftyTwoWeekLow.toFixed(2)}`
      if (data.pe) text += ` | P/E: ${data.pe.toFixed(2)}`
    }

    sdk.event.emit(TuiEvent.PromptAppend, { text })
    dialog.clear()
  }

  useKeyboard((evt) => {
    const isEnter = evt.name === "return" || evt.name === "enter" || evt.key === "\r"

    // Detail view controls
    if (detailView()) {
      if (evt.name === "escape") {
        dialog.clear() // Close entire dialog
      } else if (evt.name === "backspace") {
        setDetailView(null) // Go back to list
      } else if (isEnter) {
        insertToChat(detailView()!)
      }
      return
    }

    // List view controls
    if (evt.name === "escape") {
      dialog.clear()
    } else if (evt.name === "up") {
      setSelected((s) => Math.max(0, s - 1))
    } else if (evt.name === "down") {
      setSelected((s) => Math.min(totalCount() - 1, s + 1))
    } else if (isEnter) {
      const list = priceList()
      if (list[selected()]) {
        const [symbol, data] = list[selected()]
        setDetailView({ ...data, symbol })
      }
    } else if (evt.key === "r") {
      fetchPrices(true)
    }
  })

  const formatVolume = (vol: number) => {
    if (vol >= 1_000_000_000) return `${(vol / 1_000_000_000).toFixed(2)}B`
    if (vol >= 1_000_000) return `${(vol / 1_000_000).toFixed(2)}M`
    if (vol >= 1_000) return `${(vol / 1_000).toFixed(2)}K`
    return vol.toFixed(0)
  }

  const formatMarketCap = (cap?: number) => {
    if (!cap) return "N/A"
    if (cap >= 1_000_000_000_000) return `$${(cap / 1_000_000_000_000).toFixed(2)}T`
    if (cap >= 1_000_000_000) return `$${(cap / 1_000_000_000).toFixed(2)}B`
    if (cap >= 1_000_000) return `$${(cap / 1_000_000).toFixed(2)}M`
    return `$${cap.toFixed(0)}`
  }

  const formatTime = (timestamp?: number) => {
    if (!timestamp) return "N/A"
    return new Date(timestamp).toLocaleTimeString()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      {/* Detail view - replaces the price list when active */}
      <Show when={detailView()}>
        {(data) => {
          const symbolColor = isCrypto(data().symbol) ? CRYPTO_COLOR : theme.accent
          const change = () => data().close - data().open
          const changePercent = () => data().open ? ((change() / data().open) * 100) : 0
          const changeColor = () => change() >= 0 ? theme.success : theme.error

          return (
            <>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={symbolColor} attributes={TextAttributes.BOLD}>
                  {data().symbol} Details
                </text>
                <text fg={theme.textMuted}>esc</text>
              </box>

              <box marginTop={1} gap={1}>
                <box flexDirection="row" gap={2}>
                  <text fg={theme.textMuted} width={14}>Price:</text>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    ${data().close?.toFixed(2) ?? "N/A"}
                  </text>
                  <text fg={changeColor()}>
                    ({change() >= 0 ? "+" : ""}{changePercent().toFixed(2)}%)
                  </text>
                </box>

                <box flexDirection="row" gap={2}>
                  <text fg={theme.textMuted} width={14}>Open:</text>
                  <text fg={theme.text}>${data().open?.toFixed(2) ?? "N/A"}</text>
                </box>

                <box flexDirection="row" gap={2}>
                  <text fg={theme.textMuted} width={14}>High:</text>
                  <text fg={theme.success}>${data().high?.toFixed(2) ?? "N/A"}</text>
                </box>

                <box flexDirection="row" gap={2}>
                  <text fg={theme.textMuted} width={14}>Low:</text>
                  <text fg={theme.error}>${data().low?.toFixed(2) ?? "N/A"}</text>
                </box>

                <box flexDirection="row" gap={2}>
                  <text fg={theme.textMuted} width={14}>Volume:</text>
                  <text fg={theme.text}>{formatVolume(data().volume ?? 0)}</text>
                </box>

                {/* Extra stock data - only for stocks */}
                <Show when={!isCrypto(data().symbol)}>
                  <box flexDirection="row" gap={2}>
                    <text fg={theme.textMuted} width={14}>Market Cap:</text>
                    <text fg={theme.text}>{formatMarketCap(data().marketCap)}</text>
                  </box>

                  <box flexDirection="row" gap={2}>
                    <text fg={theme.textMuted} width={14}>52W High:</text>
                    <text fg={theme.success}>${data().fiftyTwoWeekHigh?.toFixed(2) ?? "N/A"}</text>
                  </box>

                  <box flexDirection="row" gap={2}>
                    <text fg={theme.textMuted} width={14}>52W Low:</text>
                    <text fg={theme.error}>${data().fiftyTwoWeekLow?.toFixed(2) ?? "N/A"}</text>
                  </box>

                  <Show when={data().pe}>
                    <box flexDirection="row" gap={2}>
                      <text fg={theme.textMuted} width={14}>P/E Ratio:</text>
                      <text fg={theme.text}>{data().pe?.toFixed(2)}</text>
                    </box>
                  </Show>
                </Show>

                <box flexDirection="row" gap={2}>
                  <text fg={theme.textMuted} width={14}>Updated:</text>
                  <text fg={theme.text}>{formatTime(data().timestamp)}</text>
                </box>
              </box>

              <box marginTop={2}>
                <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                  [Enter] Insert all {data().symbol} data to chat
                </text>
              </box>

              <text fg={theme.textMuted} marginTop={1}>
                <b>enter</b> insert to chat • <b>backspace</b> back
              </text>
            </>
          )
        }}
      </Show>

      {/* Price list - hidden when detail view is active */}
      <Show when={!detailView()}>
        <box flexDirection="row" justifyContent="space-between">
          <box flexDirection="row" gap={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Live Prices
            </text>
            <Show when={refreshing()}>
              <text fg={theme.accent}>refreshing...</text>
            </Show>
            <Show when={!refreshing() && lastUpdate()}>
              <text fg={theme.textMuted}>
                updated {lastUpdate()?.toLocaleTimeString()}
              </text>
            </Show>
          </box>
          <text fg={theme.textMuted}>esc</text>
        </box>

        <Show when={initialLoading() && priceList().length === 0}>
          <text fg={theme.textMuted}>Loading...</text>
        </Show>

        <Show when={priceList().length > 0}>
          {/* Header */}
          <box flexDirection="row" gap={2}>
            <text fg={theme.textMuted} width={8}>Symbol</text>
            <text fg={theme.textMuted} width={12}>Price</text>
            <text fg={theme.textMuted} width={10}>High</text>
            <text fg={theme.textMuted} width={10}>Low</text>
          </box>

          {/* Stock rows */}
          <For each={stockList()}>
            {([symbol, data], i) => (
              <box
                flexDirection="row"
                gap={2}
                backgroundColor={selected() === i() ? theme.backgroundElement : undefined}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={theme.text} width={8}>
                  <b>{symbol}</b>
                </text>
                <text fg={theme.text} width={12}>
                  ${data.close?.toFixed(2) ?? "N/A"}
                </text>
                <text fg={theme.success} width={10}>
                  ${data.high?.toFixed(2) ?? "N/A"}
                </text>
                <text fg={theme.error} width={10}>
                  ${data.low?.toFixed(2) ?? "N/A"}
                </text>
              </box>
            )}
          </For>

          {/* Crypto section */}
          <Show when={cryptoList().length > 0}>
            <text fg={CRYPTO_COLOR} marginTop={1} attributes={TextAttributes.BOLD}>
              Crypto
            </text>
            <For each={cryptoList()}>
              {([symbol, data], i) => (
                <box
                  flexDirection="row"
                  gap={2}
                  backgroundColor={selected() === stockList().length + i() ? theme.backgroundElement : undefined}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={CRYPTO_COLOR} width={8}>
                    <b>{symbol}</b>
                  </text>
                  <text fg={theme.text} width={12}>
                    ${data.close?.toFixed(2) ?? "N/A"}
                  </text>
                  <text fg={theme.success} width={10}>
                    ${data.high?.toFixed(2) ?? "N/A"}
                  </text>
                  <text fg={theme.error} width={10}>
                    ${data.low?.toFixed(2) ?? "N/A"}
                  </text>
                </box>
              )}
            </For>
          </Show>
        </Show>

        <Show when={!initialLoading() && priceList().length === 0}>
          <Show when={error()}>
            <text fg={theme.error}>{error()}</text>
          </Show>
          <text fg={theme.textMuted}>No price data available</text>
          <text fg={theme.textMuted}>Make sure simulator is running:</text>
          <text fg={theme.accent}>source venv/bin/activate && python simulator/main.py</text>
        </Show>

        <text fg={theme.textMuted} marginTop={1}>
          <b>↑/↓</b> navigate • <b>enter</b> details • <b>r</b> refresh • <b>esc</b> close
        </text>
      </Show>
    </box>
  )
}
