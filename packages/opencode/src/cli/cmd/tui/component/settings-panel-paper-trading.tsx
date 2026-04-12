import { createSignal, For, onMount, Show } from "solid-js"
import { MouseEvent, TextAttributes } from "@opentui/core"
import open from "open"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { Card } from "./card"
import {
  type AlpacaAccount,
  listAlpacaAccounts,
  generateProviderID,
  maskKey,
} from "@/live/alpaca-accounts"

const ALPACA_DOCS_URL =
  "https://docs.alpaca.markets/docs/getting-started#creating-an-alpaca-account-and-finding-your-api-keys"

export function SettingsPanelPaperTrading() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()

  const [accounts, setAccounts] = createSignal<AlpacaAccount[]>([])
  const [busy, setBusy] = createSignal(false)

  // Form state
  const [label, setLabel] = createSignal("")
  const [keyId, setKeyId] = createSignal("")
  const [secret, setSecret] = createSignal("")
  const [endpoint, setEndpoint] = createSignal("https://paper-api.alpaca.markets")

  const refreshAccounts = async () => {
    try {
      setAccounts(await listAlpacaAccounts())
    } catch {
      setAccounts([])
    }
  }

  onMount(() => {
    refreshAccounts()
  })

  const save = async () => {
    if (busy()) return
    const l = label().trim()
    const k = keyId().trim()
    const s = secret().trim()
    if (!l) {
      toast.show({ message: "Label is required", variant: "warning", duration: 3000 })
      return
    }
    if (!k || !s) {
      toast.show({ message: "Both API Key ID and Secret are required", variant: "warning", duration: 3000 })
      return
    }
    setBusy(true)
    try {
      const providerID = generateProviderID()
      const result = await sdk.client.auth.set({
        providerID,
        auth: {
          type: "api",
          key: s,
          metadata: {
            keyId: k,
            endpoint: endpoint().trim() || "https://paper-api.alpaca.markets",
            kind: "alpaca-paper",
            label: l,
          },
        },
      })
      if ((result as any)?.error) {
        throw new Error((result as any).error?.message ?? "auth.set returned an error")
      }
      toast.show({ message: `✓ Account "${l}" saved`, variant: "info", duration: 5000 })
      setLabel("")
      setKeyId("")
      setSecret("")
      setEndpoint("https://paper-api.alpaca.markets")
      await refreshAccounts()
    } catch (e: any) {
      toast.show({ message: `Failed to save: ${e?.message ?? "unknown error"}`, variant: "error", duration: 6000 })
    } finally {
      setBusy(false)
    }
  }

  const removeAccount = async (account: AlpacaAccount) => {
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

  const Label = (props: { text: string }) => <text fg={theme.textMuted}>{props.text}</text>

  const InputBox = (props: { onInput: (v: string) => void }) => (
    <box
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      flexShrink={0}
    >
      <input
        onInput={(v: string) => props.onInput(v)}
        onMouseDown={(r: MouseEvent) => r.target?.focus()}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        focusedTextColor={theme.text}
      />
    </box>
  )

  return (
    <box flexGrow={1} flexDirection="row" gap={2} minHeight={0}>
      {/* Provider list */}
      <box width={36} flexShrink={0} minHeight={0}>
        <Card title=" Paper trading ">
          <box flexDirection="column" gap={2}>
            <box flexDirection="column" gap={0}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                ◆ Alpaca (paper)
              </text>
              <text fg={theme.textMuted}>Stocks · ETFs · Options</text>
              <Show
                when={accounts().length > 0}
                fallback={<text fg={theme.textMuted}>not connected</text>}
              >
                <text fg={theme.success} attributes={TextAttributes.BOLD}>
                  ✓ {accounts().length} account{accounts().length !== 1 ? "s" : ""}
                </text>
              </Show>
            </box>

            <box flexDirection="column" gap={0}>
              <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                ○ Alpaca (live)
              </text>
              <text fg={theme.textMuted}>Real brokerage account</text>
              <text fg={theme.warning}>coming soon</text>
            </box>

            <box flexDirection="column" gap={0}>
              <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                ○ Algoclash
              </text>
              <text fg={theme.textMuted}>Crypto · Community</text>
              <text fg={theme.warning}>coming soon</text>
            </box>
          </box>
        </Card>
      </box>

      {/* Right pane */}
      <box flexGrow={1} minHeight={0}>
        <Card title=" Alpaca paper accounts ">
          <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
            <box flexDirection="column" gap={1}>
              {/* Saved accounts list */}
              <Show
                when={accounts().length > 0}
                fallback={
                  <text fg={theme.textMuted}>
                    No accounts connected. Add one below.
                  </text>
                }
              >
                <box flexDirection="column" gap={1}>
                  <For each={accounts()}>
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
                          <text fg={theme.textMuted}>
                            Key: {maskKey(account.keyId)}
                          </text>
                        </box>
                        <box
                          paddingLeft={1}
                          paddingRight={1}
                          onMouseUp={() => removeAccount(account)}
                        >
                          <text fg={theme.error}>Remove</text>
                        </box>
                      </box>
                    )}
                  </For>
                </box>
              </Show>

              {/* Add new account form */}
              <box paddingTop={2}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                  Add account
                </text>
              </box>

              <text fg={theme.textMuted}>
                Sign up for a free Alpaca paper account, then paste your API keys.
              </text>
              <box
                paddingLeft={1}
                paddingRight={1}
                flexDirection="row"
                onMouseUp={() => {
                  open(ALPACA_DOCS_URL).catch(() => {
                    toast.show({ message: ALPACA_DOCS_URL, variant: "info", duration: 5000 })
                  })
                  toast.show({ message: "Opening Alpaca docs in browser…", variant: "info", duration: 2000 })
                }}
              >
                <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                  → Open Alpaca docs
                </text>
              </box>

              <box paddingTop={1}>
                <Label text="Account label (e.g. Main, Crypto, Test)" />
              </box>
              <InputBox onInput={setLabel} />

              <box paddingTop={1}>
                <Label text="API Key ID (starts with PK…)" />
              </box>
              <InputBox onInput={setKeyId} />

              <box paddingTop={1}>
                <Label text="Secret Key" />
              </box>
              <InputBox onInput={setSecret} />

              <box paddingTop={1}>
                <Label text="Endpoint" />
              </box>
              <InputBox onInput={setEndpoint} />

              <box paddingTop={2} flexDirection="row">
                <box
                  paddingLeft={2}
                  paddingRight={2}
                  backgroundColor={busy() ? theme.borderSubtle : theme.primary}
                  onMouseUp={save}
                >
                  <text fg={theme.background} attributes={TextAttributes.BOLD}>
                    {busy() ? "Saving…" : "→ Add account"}
                  </text>
                </box>
              </box>

              <box
                paddingTop={2}
                paddingLeft={1}
                paddingRight={1}
                paddingBottom={1}
                border={["left"]}
                borderColor={theme.warning}
                flexDirection="column"
                gap={0}
              >
                <text fg={theme.warning} attributes={TextAttributes.BOLD}>
                  ⚠ Not investment advice
                </text>
                <text fg={theme.textMuted}>
                  Keys are saved locally at ~/.local/share/finny/auth.json (0600 perms). Finny servers never see them.
                </text>
                <text fg={theme.textMuted}>
                  Paper trading uses virtual money. Strategies generated here are not financial advice.
                </text>
              </box>
            </box>
          </scrollbox>
        </Card>
      </box>
    </box>
  )
}
