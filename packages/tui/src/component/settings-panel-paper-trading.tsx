import { createSignal, For, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { Card } from "./card"
import { maskKey } from "@/live/alpaca-accounts"
import { BrokerRegistry, type BrokerAccount, type BrokerKind, type BrokerSpec } from "@/live/brokers"
import { RobinhoodManager } from "./dialog-robinhood"

function brokerSubtitle(spec: BrokerSpec): string {
  if (spec.kind === "alpaca") return "Stocks · ETFs · Crypto"
  if (spec.kind === "binance") return "Crypto spot · USDT pairs"
  if (spec.kind === "robinhood") return "Stocks/ETFs beta · Crypto official"
  return spec.assetClasses.join(" · ")
}

export function SettingsPanelPaperTrading() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()

  const allSpecs = BrokerRegistry.specs()
  const [activeKind, setActiveKind] = createSignal<BrokerKind>(allSpecs[0]?.kind ?? "alpaca")
  const activeSpec = () => BrokerRegistry.getSpec(activeKind())

  const [allAccounts, setAllAccounts] = createSignal<BrokerAccount[]>([])
  const [busy, setBusy] = createSignal(false)

  const accountsForKind = (kind: BrokerKind) => allAccounts().filter((a) => a.brokerKind === kind)

  const refreshAccounts = async () => {
    try {
      setAllAccounts(await BrokerRegistry.listAccounts())
    } catch {
      setAllAccounts([])
    }
  }

  onMount(() => {
    refreshAccounts()
  })

  const removeAccount = async (account: BrokerAccount) => {
    if (busy()) return
    setBusy(true)
    try {
      await sdk.client.auth.remove({ providerID: account.providerID })
      toast.show({ message: `Removed "${account.label}"`, variant: "info", duration: 3000 })
      await refreshAccounts()
    } catch (e: any) {
      toast.show({ message: `Failed to remove: ${e?.message ?? "unknown error"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  return (
    <box flexGrow={1} flexDirection="row" gap={2} minHeight={0}>
      {/* Brokerage list */}
      <box width={36} flexShrink={0} minHeight={0}>
        <Card title=" Brokerages ">
          <box flexDirection="column" gap={2}>
            <For each={allSpecs}>
              {(spec) => {
                const isActive = () => activeKind() === spec.kind
                const count = () => accountsForKind(spec.kind).length
                return (
                  <box
                    flexDirection="column"
                    gap={0}
                    paddingLeft={1}
                    paddingRight={1}
                    paddingTop={0}
                    paddingBottom={0}
                    backgroundColor={isActive() ? theme.backgroundElement : undefined}
                    onMouseUp={() => setActiveKind(spec.kind)}
                  >
                    <text fg={isActive() ? theme.primary : theme.text} attributes={TextAttributes.BOLD}>
                      ◆ {spec.displayName}
                    </text>
                    <text fg={theme.textMuted}>{brokerSubtitle(spec)}</text>
                    <Show when={count() > 0} fallback={<text fg={theme.textMuted}>not connected</text>}>
                      <text fg={theme.success} attributes={TextAttributes.BOLD}>
                        ✓ {count()} account{count() !== 1 ? "s" : ""}
                      </text>
                    </Show>
                  </box>
                )
              }}
            </For>
          </box>
        </Card>
      </box>

      {/* Right pane — Robinhood has a dedicated credentialless connector flow. */}
      <box flexGrow={1} minHeight={0}>
        <Show
          when={activeKind() === "robinhood"}
          fallback={
            <Card title={` ${activeSpec().displayName} accounts `}>
              <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
                <box flexDirection="column" gap={1}>
                  <Show
                    when={accountsForKind(activeKind()).length > 0}
                    fallback={
                      <box flexDirection="column" gap={1}>
                        <text fg={theme.textMuted}>No {activeSpec().displayName} accounts connected.</text>
                        <text fg={theme.textMuted}>Add one from the Portfolio page.</text>
                      </box>
                    }
                  >
                    <box flexDirection="column" gap={1}>
                      <For each={accountsForKind(activeKind())}>
                        {(account) => (
                          <box
                            paddingLeft={1}
                            paddingRight={1}
                            paddingTop={1}
                            paddingBottom={1}
                            backgroundColor={theme.backgroundElement}
                            flexDirection="row"
                            justifyContent="space-between"
                            gap={2}
                          >
                            <box flexDirection="column" flexGrow={1}>
                              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                                {account.label}
                              </text>
                              <text fg={theme.textMuted}>Key: {maskKey(account.keyId)}</text>
                            </box>
                            <box paddingLeft={1} paddingRight={1} onMouseUp={() => removeAccount(account)}>
                              <text fg={theme.error}>Remove</text>
                            </box>
                          </box>
                        )}
                      </For>
                    </box>
                  </Show>
                </box>
              </scrollbox>
            </Card>
          }
        >
          <Card title=" Robinhood ">
            <RobinhoodManager onChanged={() => void refreshAccounts()} />
          </Card>
        </Show>
      </box>
    </box>
  )
}
