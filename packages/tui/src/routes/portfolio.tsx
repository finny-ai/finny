import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { useLiveRuns } from "../context/live-runs"
import { Card } from "../component/card"
import { RouteHeader, ROUTE_ICONS } from "../component/route-header"
import { DialogLiveRun } from "../component/dialog-live-run"
import { DialogAddAccount } from "../component/dialog-add-account"
import { ModeBadge } from "../component/mode-badge"
import { maskKey } from "@/live/alpaca-accounts"
import { BrokerRegistry, type BrokerAccount, type BrokerKind } from "@/live/brokers"
import { SegmentedControl, type SegmentedOption } from "../ui/segmented-control"
import { Link } from "../ui/link"
import { DialogRobinhood } from "../component/dialog-robinhood"

function formatCurrency(value?: number): string {
  if (value === undefined || value === null || !isFinite(value)) return "—"
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function Portfolio() {
  const { theme } = useTheme()
  const route = useRoute()
  const liveRuns = useLiveRuns()
  const dialog = useDialog()

  const allSpecs = BrokerRegistry.specs()
  const [accounts, setAccounts] = createSignal<BrokerAccount[]>([])
  const [activeKind, setActiveKind] = createSignal<BrokerKind>(allSpecs[0]?.kind ?? "alpaca")

  const refreshAccounts = async () => {
    try {
      setAccounts(await BrokerRegistry.listAccounts())
    } catch {
      setAccounts([])
    }
  }

  onMount(async () => {
    await refreshAccounts()
    // Prefer the first broker that has accounts.
    const first = allSpecs.find((s) => accounts().some((a) => a.brokerKind === s.kind))
    if (first) setActiveKind(first.kind)
  })

  const activeRuns = createMemo(() =>
    liveRuns.runs().filter((r) => r.status === "running" || r.status === "starting"),
  )

  const accountsForKind = (kind: BrokerKind) => accounts().filter((a) => a.brokerKind === kind)
  const activeSpec = () => BrokerRegistry.getSpec(activeKind())
  const connected = () => accountsForKind(activeKind()).length > 0

  const tabOptions = (): SegmentedOption<BrokerKind>[] =>
    allSpecs.map((s) => {
      const n = accountsForKind(s.kind).length
      return {
        value: s.kind,
        label: s.displayName,
        badge: n > 0 ? `· ${n}` : undefined,
      }
    })

  const goToSettings = () => route.navigate({ type: "settings", tab: "paper-trading" })

  const openAddDialog = async () => {
    if (activeKind() === "robinhood") {
      await DialogRobinhood.show(dialog, { onChanged: () => void refreshAccounts() })
      await refreshAccounts()
      return
    }
    const saved = await DialogAddAccount.show(dialog, { initialKind: activeKind() })
    if (saved) await refreshAccounts()
  }

  const totalAccounts = () => accounts().length
  const brokerCount = () => allSpecs.filter((s) => accountsForKind(s.kind).length > 0).length

  return (
    <box flexGrow={1} flexDirection="column">
      <RouteHeader
        icon={ROUTE_ICONS.portfolio as unknown as string[]}
        title="Portfolio"
        subtitle="Positions across your connected brokerages"
        right={
          <box
            paddingLeft={2}
            paddingRight={1}
            border={["left"]}
            borderColor={theme.info}
            flexDirection="column"
            gap={0}
            flexShrink={0}
          >
            <text fg={theme.info} attributes={TextAttributes.BOLD}>
              Not investment advice
            </text>
            <text fg={theme.textMuted}>
              API keys are saved locally (0600). Robinhood credentials stay in RHX / the OS keychain.
            </text>
            <text fg={theme.textMuted}>
              Paper / testnet uses virtual money. Strategies are not financial advice.
            </text>
          </box>
        }
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
                  {(run) => {
                    const brokerLabel = () => {
                      const k = (run as any).brokerKind as BrokerKind | undefined
                      return k ? BrokerRegistry.getSpec(k).displayName : "Alpaca paper"
                    }
                    // Prefer the mode recorded on the run; fall back to the
                    // matching connected account for runs started before the
                    // field existed.
                    const runMode = () =>
                      run.mode ??
                      accounts().find((a) => a.providerID === run.accountProviderID)?.mode
                    return (
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
                        <ModeBadge mode={runMode()} />
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
                        <box width={18} flexShrink={0}>
                          <text fg={theme.textMuted}>
                            {brokerLabel()}
                            <Show when={run.accountLabel}> · {run.accountLabel}</Show>
                          </text>
                        </box>
                        <box flexGrow={1}>
                          <text fg={theme.textMuted}>click to open logs</text>
                        </box>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Card>
          </box>
        </Show>

        {/* Brokerage tabs */}
        <SegmentedControl
          options={tabOptions()}
          value={activeKind()}
          onChange={setActiveKind}
        />

        <Show when={totalAccounts() > 0}>
          <text fg={theme.textMuted}>
            {totalAccounts()} account{totalAccounts() !== 1 ? "s" : ""} across {brokerCount()} brokerage
            {brokerCount() !== 1 ? "s" : ""}.
          </text>
        </Show>

        {/* Active broker accounts */}
        <box flexShrink={0}>
          <Card title={` ${activeSpec().displayName} accounts `}>
            <Show
              when={connected()}
              fallback={
                <box alignItems="center" justifyContent="center" gap={1} flexShrink={0}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    {activeSpec().displayName} not connected
                  </text>
                  <text fg={theme.textMuted}>
                    Connect a {activeSpec().displayName} account to see live positions.
                  </text>
                  <Show when={activeSpec().docsUrl && activeKind() !== "robinhood"}>
                    <box flexDirection="row" flexShrink={0}>
                      <text fg={theme.textMuted}>Get keys at </text>
                      <Link href={activeSpec().docsUrl} fg={theme.primary}>
                        {activeSpec().docsUrl}
                      </Link>
                    </box>
                  </Show>
                  <box
                    paddingLeft={2}
                    paddingRight={2}
                    backgroundColor={theme.primary}
                    onMouseUp={openAddDialog}
                  >
                    <text fg={theme.background} attributes={TextAttributes.BOLD}>
                      → {activeKind() === "robinhood" ? "Set up Robinhood" : `Connect ${activeSpec().displayName}`}
                    </text>
                  </box>
                </box>
              }
            >
              <box flexDirection="column" gap={1} flexShrink={0}>
                <For each={accountsForKind(activeKind())}>
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
                      <ModeBadge mode={account.mode} />
                      <text fg={theme.textMuted}>
                        {account.brokerKind === "robinhood"
                          ? `RHX profile: ${account.keyId}`
                          : `Key: ${maskKey(account.keyId)}`}
                      </text>
                    </box>
                  )}
                </For>
                <text fg={theme.textMuted}>
                  Positions, cash, and P&L will render here once a live runner reports back.
                </text>
                <Show when={activeSpec().docsUrl && activeKind() !== "robinhood"}>
                  <box flexDirection="row" flexShrink={0}>
                    <text fg={theme.textMuted}>Account dashboard: </text>
                    <Link href={activeSpec().docsUrl} fg={theme.primary}>
                      {activeSpec().docsUrl}
                    </Link>
                  </box>
                </Show>
                <box flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
                  <box
                    paddingLeft={2}
                    paddingRight={2}
                    backgroundColor={theme.success}
                    onMouseUp={openAddDialog}
                  >
                    <text fg={theme.background} attributes={TextAttributes.BOLD}>
                      {activeKind() === "robinhood" ? "Manage Robinhood" : `+ Add ${activeSpec().displayName} account`}
                    </text>
                  </box>
                  <box
                    paddingLeft={2}
                    paddingRight={2}
                    backgroundColor={theme.backgroundElement}
                    onMouseUp={goToSettings}
                  >
                    <text fg={theme.text}>Manage in Settings</text>
                  </box>
                </box>
              </box>
            </Show>
          </Card>
        </box>

      </box>
    </box>
  )
}
