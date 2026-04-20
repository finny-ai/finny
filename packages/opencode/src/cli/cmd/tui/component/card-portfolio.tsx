import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { useLiveRuns } from "../context/live-runs"
import { Card } from "./card"
import { type AlpacaAccount, listAlpacaAccounts } from "@/live/alpaca-accounts"

function formatCurrency(value?: number): string {
  if (value === undefined || value === null || !isFinite(value)) return "—"
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function PortfolioCard() {
  const { theme } = useTheme()
  const route = useRoute()
  const liveRuns = useLiveRuns()

  const [accounts, setAccounts] = createSignal<AlpacaAccount[]>([])

  onMount(async () => {
    setAccounts(await listAlpacaAccounts())
  })

  const activeRuns = createMemo(() =>
    liveRuns.runs().filter((r) => r.status === "running" || r.status === "starting"),
  )

  const connected = () => accounts().length > 0 || activeRuns().length > 0

  return (
    <Card title=" Portfolio ">
      <box
        flexGrow={1}
        flexDirection="column"
        gap={1}
        onMouseUp={() => route.navigate({ type: "portfolio" })}
      >
        <Show
          when={connected()}
          fallback={
            <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
              <text fg={theme.textMuted}>No portfolio connected</text>
              <text fg={theme.textMuted}>
                Click to set up paper trading.
              </text>
            </box>
          }
        >
          <Show when={activeRuns().length > 0}>
            <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
              <text fg={theme.success} attributes={TextAttributes.BOLD}>
                {activeRuns().length} algo{activeRuns().length > 1 ? "s" : ""} running
              </text>
              <box flexDirection="column">
                <For each={activeRuns().slice(0, 2)}>
                  {(run) => (
                    <box flexDirection="row" gap={2}>
                      <text fg={theme.success}>●</text>
                      <text fg={theme.text}>{run.algorithmName}</text>
                      <text fg={theme.textMuted}>
                        {formatCurrency(run.equity)}
                      </text>
                    </box>
                  )}
                </For>
                <Show when={activeRuns().length > 2}>
                  <text fg={theme.textMuted}>
                    +{activeRuns().length - 2} more
                  </text>
                </Show>
              </box>
            </box>
          </Show>
          <Show when={activeRuns().length === 0 && accounts().length > 0}>
            <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
              <text fg={theme.text}>
                {accounts().length} account{accounts().length > 1 ? "s" : ""} connected
              </text>
              <text fg={theme.textMuted}>
                No algos running. Click to view.
              </text>
            </box>
          </Show>
        </Show>
      </box>
    </Card>
  )
}
