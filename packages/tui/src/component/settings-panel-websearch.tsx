import { createSignal, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { Card } from "./card"
import { Link } from "../ui/link"
import { Auth } from "@/auth"
import { maskPerplexityKey, PERPLEXITY_PROVIDER_ID } from "@/tool/perplexity-credentials"

type Connection = {
  connected: boolean
  masked: string
  source: "auth" | "env" | "none"
}

async function loadConnection(): Promise<Connection> {
  const env = process.env.PERPLEXITY_API_KEY?.trim()
  if (env) {
    return { connected: true, masked: maskPerplexityKey(env), source: "env" }
  }
  try {
    const auth = await Auth.get(PERPLEXITY_PROVIDER_ID)
    if (auth?.type === "api" && auth.key.trim()) {
      return { connected: true, masked: maskPerplexityKey(auth.key), source: "auth" }
    }
  } catch {
    // ignore missing store
  }
  return { connected: false, masked: "", source: "none" }
}

export function SettingsPanelWebSearch() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const dialog = useDialog()

  const [connection, setConnection] = createSignal<Connection>({
    connected: false,
    masked: "",
    source: "none",
  })
  const [busy, setBusy] = createSignal(false)

  const refresh = async () => {
    setConnection(await loadConnection())
  }

  onMount(() => {
    void refresh()
  })

  const saveKey = async (value: string) => {
    const key = value.trim()
    if (!key) return
    if (busy()) return
    setBusy(true)
    try {
      await sdk.client.auth.set({
        providerID: PERPLEXITY_PROVIDER_ID,
        auth: {
          type: "api",
          key,
          metadata: {
            purpose: "websearch",
          },
        },
      })
      // Refresh provider/tool state so websearch picks up the key immediately.
      await sdk.client.instance.dispose().catch(() => undefined)
      await sync.bootstrap()
      await refresh()
      toast.show({
        message: "Perplexity API key saved locally — websearch enabled",
        variant: "success",
        duration: 3000,
      })
      dialog.clear()
    } catch (e: any) {
      toast.show({
        message: `Failed to save key: ${e?.message ?? "unknown error"}`,
        variant: "error",
        duration: 5000,
      })
    } finally {
      setBusy(false)
    }
  }

  const openAddKey = () => {
    dialog.replace(() => (
      <DialogPrompt
        title="Perplexity API key"
        placeholder="pplx-..."
        description={() => (
          <box gap={1}>
            <text fg={theme.textMuted}>
              Stored locally in auth.json (same secure store as LLM providers and brokerage keys). Used for finance
              and news websearch.
            </text>
            <text fg={theme.text}>
              Get a key at <span style={{ fg: theme.primary }}>https://www.perplexity.ai/settings/api</span>
            </text>
          </box>
        )}
        onConfirm={(value) => void saveKey(value)}
      />
    ))
  }

  const removeKey = async () => {
    if (busy()) return
    if (connection().source === "env") {
      toast.show({
        message: "Key is set via PERPLEXITY_API_KEY env — unset the env var to remove it",
        variant: "info",
        duration: 4000,
      })
      return
    }
    setBusy(true)
    try {
      await sdk.client.auth.remove({ providerID: PERPLEXITY_PROVIDER_ID })
      await sdk.client.instance.dispose().catch(() => undefined)
      await sync.bootstrap()
      await refresh()
      toast.show({ message: "Removed Perplexity API key", variant: "info", duration: 3000 })
    } catch (e: any) {
      toast.show({
        message: `Failed to remove: ${e?.message ?? "unknown error"}`,
        variant: "error",
        duration: 5000,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <box flexGrow={1} flexDirection="column" gap={2} minHeight={0}>
      <Card title=" Web search ">
        <box flexDirection="column" gap={2}>
          <text fg={theme.textMuted}>
            Connect Perplexity so Finny’s websearch tool can pull current finance and news sources with ranked titles,
            URLs, dates, and snippets.
          </text>

          <box
            flexDirection="row"
            gap={2}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.backgroundElement}
          >
            <box flexDirection="column" flexGrow={1} gap={0}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                ◆ Perplexity Search
              </text>
              <text fg={theme.textMuted}>Finance · news · research websearch</text>
              <Show
                when={connection().connected}
                fallback={<text fg={theme.textMuted}>not connected</text>}
              >
                <text fg={theme.success} attributes={TextAttributes.BOLD}>
                  ✓ connected · key {connection().masked}
                  {connection().source === "env" ? " (env)" : " (local)"}
                </text>
              </Show>
            </box>
          </box>

          <box flexDirection="row" gap={2} flexShrink={0}>
            <box
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={theme.primary}
              onMouseUp={() => {
                if (!busy()) openAddKey()
              }}
            >
              <text fg={theme.background} attributes={TextAttributes.BOLD}>
                {connection().connected ? "Update API key" : "Add API key"}
              </text>
            </box>
            <Show when={connection().connected}>
              <box
                paddingLeft={2}
                paddingRight={2}
                paddingTop={1}
                paddingBottom={1}
                backgroundColor={theme.backgroundElement}
                onMouseUp={() => {
                  if (!busy()) void removeKey()
                }}
              >
                <text fg={theme.error} attributes={TextAttributes.BOLD}>
                  Remove
                </text>
              </box>
            </Show>
          </box>

          <box flexDirection="column" gap={0}>
            <text fg={theme.textMuted}>
              Keys are stored at FINNY_HOME/auth.json with mode 0600 — the same local store used for OpenAI/Anthropic
              and brokerage credentials.
            </text>
            <text fg={theme.textMuted}>
              Optional env override: PERPLEXITY_API_KEY / OPENCODE_WEBSEARCH_PROVIDER=perplexity
            </text>
            <Link href="https://docs.perplexity.ai" fg={theme.primary} />
          </box>
        </box>
      </Card>
    </box>
  )
}
