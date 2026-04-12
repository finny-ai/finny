import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { useLiveRuns } from "../context/live-runs"
import { Card } from "../component/card"
import { RouteHeader, ROUTE_ICONS } from "../component/route-header"
import { DialogLiveRun } from "../component/dialog-live-run"
import { type AlpacaAccount, listAlpacaAccounts, maskKey } from "@/live/alpaca-accounts"
import { Link } from "../ui/link"

function formatCurrency(value?: number): string {
  if (value === undefined || value === null || !isFinite(value)) return "—"
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function Portfolio() {
  const { theme } = useTheme()
  const route = useRoute()
  const liveRuns = useLiveRuns()
  const dialog = useDialog()

  const [accounts, setAccounts] = createSignal<AlpacaAccount[]>([])

  onMount(async () => {
    setAccounts(await listAlpacaAccounts())
  })

  const activeRuns = createMemo(() =>
    liveRuns.runs().filter((r) => r.status === "running" || r.status === "starting"),
  )

  const connected = () => accounts().length > 0

  const goToSettings = () => route.navigate({ type: "settings", tab: "paper-trading" })

  return (
    <box flexGrow={1} flexDirection="column">
      <RouteHeader
        icon={ROUTE_ICONS.portfolio as unknown as string[]}
        title="Portfolio"
        subtitle="Alpaca paper trading positions and performance"
      />

      <box
        flexGrow={1}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={2}
        paddingBottom={2}
        flexDirection="column"
        gap={2}
        minHeight={0}
      >
        {/* Active live runs */}
        <Show when={activeRuns().length > 0}>
          <box flexShrink={0}>
            <Card title=" Running algos ">
              <box flexDirection="column" gap={1}>
                <For each={activeRuns()}>
                  {(run) => (
                    <box
                      flexDirection="row"
                      paddingLeft={1}
                      paddingRight={1}
                      gap={2}
                      onMouseUp={() => DialogLiveRun.show(dialog, run.id)}
                    >
                      <text fg={theme.success} attributes={TextAttributes.BOLD}>
                        ●
                      </text>
                      <box width={24} flexShrink={0}>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                          {run.algorithmName}
                        </text>
                      </box>
                      <box width={14} flexShrink={0}>
                        <text fg={theme.textMuted}>
                          {run.symbol} · {run.interval}
                        </text>
                      </box>
                      <box width={22} flexShrink={0}>
                        <text fg={theme.text}>
                          <span style={{ fg: theme.textMuted }}>equity</span>{" "}
                          {formatCurrency(run.equity)}
                        </text>
                      </box>
                      <Show when={run.accountLabel}>
                        <box width={14} flexShrink={0}>
                          <text fg={theme.textMuted}>
                            {run.accountLabel}
                          </text>
                        </box>
                      </Show>
                      <box flexGrow={1}>
                        <text fg={theme.textMuted}>click to open logs</text>
                      </box>
                    </box>
                  )}
                </For>
              </box>
            </Card>
          </box>
        </Show>

        {/* Accounts */}
        <Card title=" Alpaca Accounts ">
          <Show
            when={connected()}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Alpaca not connected
                </text>
                <text fg={theme.textMuted}>
                  Connect your Alpaca paper account to see live positions.
                </text>
                <text fg={theme.textMuted}>
                  Get free keys at docs.alpaca.markets, then paste them in Settings.
                </text>
                <box height={1} minHeight={0} />
                <box
                  paddingLeft={2}
                  paddingRight={2}
                  backgroundColor={theme.primary}
                  onMouseUp={goToSettings}
                >
                  <text fg={theme.background} attributes={TextAttributes.BOLD}>
                    → Connect Alpaca in Settings
                  </text>
                </box>
              </box>
            }
          >
            <box flexDirection="column" gap={1}>
              <For each={accounts()}>
                {(account) => (
                  <box
                    flexDirection="row"
                    gap={2}
                    paddingLeft={1}
                    paddingRight={1}
                    flexShrink={0}
                  >
                    <text fg={theme.success} attributes={TextAttributes.BOLD}>
                      ✓
                    </text>
                    <box width={20} flexShrink={0}>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        {account.label}
                      </text>
                    </box>
                    <text fg={theme.textMuted}>
                      Key: {maskKey(account.keyId)}
                    </text>
                  </box>
                )}
              </For>
              <box height={1} minHeight={0} />
              <text fg={theme.textMuted}>
                Positions, cash, and P&L will render here once the live runner reports back.
              </text>
              <box flexDirection="row" flexShrink={0}>
                <text fg={theme.textMuted}>For now, check your account at </text>
                <Link href="https://app.alpaca.markets/paper/dashboard/overview" fg={theme.primary}>
                  app.alpaca.markets/paper/dashboard/overview
                </Link>
                <text fg={theme.textMuted}>.</text>
              </box>
              <box height={1} minHeight={0} />
              <box flexDirection="row" gap={2} flexShrink={0}>
                <box
                  paddingLeft={2}
                  paddingRight={2}
                  backgroundColor={theme.backgroundElement}
                  onMouseUp={goToSettings}
                >
                  <text fg={theme.text}>Manage accounts</text>
                </box>
              </box>
            </box>
          </Show>
        </Card>
      </box>
    </box>
  )
}
