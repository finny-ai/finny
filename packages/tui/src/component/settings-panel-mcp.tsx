import { createMemo, createSignal, For, Show } from "solid-js"
import { MouseEvent, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { useToast } from "../ui/toast"
import { Card } from "./card"
import { entries, pipe, sortBy } from "remeda"

type McpType = "local" | "remote"

export function SettingsPanelMcp() {
  const { theme } = useTheme()
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const toast = useToast()

  const [kind, setKind] = createSignal<McpType>("local")
  const [name, setName] = createSignal("")
  const [command, setCommand] = createSignal("")
  const [argsStr, setArgsStr] = createSignal("")
  const [url, setUrl] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  const list = createMemo(() =>
    pipe(sync.data.mcp ?? {}, entries(), sortBy(([n]) => n)),
  )

  const resetForm = () => {
    setName("")
    setCommand("")
    setArgsStr("")
    setUrl("")
  }

  const submit = async () => {
    if (busy()) return
    const n = name().trim()
    if (!n) {
      toast.show({ message: "Name is required", variant: "warning", duration: 3000 })
      return
    }
    if (kind() === "local" && !command().trim()) {
      toast.show({ message: "Command is required for local MCP", variant: "warning", duration: 3000 })
      return
    }
    if (kind() === "remote" && !url().trim()) {
      toast.show({ message: "URL is required for remote MCP", variant: "warning", duration: 3000 })
      return
    }
    setBusy(true)
    try {
      const config =
        kind() === "local"
          ? {
              type: "local" as const,
              command: [command().trim(), ...argsStr().trim().split(/\s+/).filter(Boolean)],
              enabled: true,
            }
          : {
              type: "remote" as const,
              url: url().trim(),
              enabled: true,
            }
      // @ts-expect-error — SDK generated types may not include mcp.add
      await sdk.client.mcp.add({ body: { name: n, config } })
      const status = await sdk.client.mcp.status()
      if (status.data) sync.set("mcp", status.data)
      toast.show({ message: `Added MCP server "${n}"`, variant: "info", duration: 3000 })
      resetForm()
    } catch (e: any) {
      toast.show({
        message: `Failed to add MCP: ${e?.message ?? "unknown error"}`,
        variant: "error",
        duration: 5000,
      })
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (n: string) => {
    try {
      await local.mcp.toggle(n)
      const status = await sdk.client.mcp.status()
      if (status.data) sync.set("mcp", status.data)
    } catch (e: any) {
      toast.show({ message: `Toggle failed: ${e?.message ?? "unknown"}`, variant: "error", duration: 3000 })
    }
  }

  const Label = (props: { text: string }) => <text fg={theme.textMuted}>{props.text}</text>

  const InputBox = (props: {
    onInput: (v: string) => void
    placeholder?: string
  }) => (
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
        placeholder={props.placeholder}
        placeholderColor={theme.textMuted}
      />
    </box>
  )

  return (
    <box flexGrow={1} flexDirection="row" gap={2} minHeight={0}>
      {/* Installed */}
      <box width={40} flexShrink={0} minHeight={0}>
        <Card title=" Installed servers ">
          <Show
            when={list().length > 0}
            fallback={<text fg={theme.textMuted}>No MCP servers configured yet.</text>}
          >
            <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
              <box flexDirection="column" gap={1}>
                <For each={list()}>
                  {([serverName, status]) => {
                    const enabled = createMemo(() => local.mcp.isEnabled(serverName))
                    return (
                      <box
                        flexDirection="row"
                        paddingLeft={1}
                        paddingRight={1}
                        onMouseUp={() => toggle(serverName)}
                      >
                        <text fg={enabled() ? theme.success : theme.textMuted}>
                          {enabled() ? "✓ " : "○ "}
                        </text>
                        <box flexGrow={1} flexDirection="column">
                          <text fg={theme.text} attributes={TextAttributes.BOLD}>
                            {serverName}
                          </text>
                          <text fg={theme.textMuted}>
                            {status.status === "failed" ? "failed" : status.status}
                          </text>
                        </box>
                      </box>
                    )
                  }}
                </For>
              </box>
            </scrollbox>
          </Show>
        </Card>
      </box>

      {/* Add new */}
      <box flexGrow={1} minHeight={0}>
        <Card title=" Add new MCP server ">
          <box flexDirection="column" gap={1}>
            <Label text="Type" />
            <box flexDirection="row" gap={2} flexShrink={0}>
              <box
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={kind() === "local" ? theme.primary : theme.backgroundElement}
                onMouseUp={() => setKind("local")}
              >
                <text
                  fg={kind() === "local" ? theme.background : theme.text}
                  attributes={TextAttributes.BOLD}
                >
                  local (stdio)
                </text>
              </box>
              <box
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={kind() === "remote" ? theme.primary : theme.backgroundElement}
                onMouseUp={() => setKind("remote")}
              >
                <text
                  fg={kind() === "remote" ? theme.background : theme.text}
                  attributes={TextAttributes.BOLD}
                >
                  remote (http)
                </text>
              </box>
            </box>

            <box paddingTop={1}>
              <Label text="Name" />
            </box>
            <InputBox onInput={setName} placeholder="github" />

            <Show when={kind() === "local"}>
              <box paddingTop={1}>
                <Label text="Command" />
              </box>
              <InputBox onInput={setCommand} placeholder="npx" />

              <box paddingTop={1}>
                <Label text="Args (space-separated)" />
              </box>
              <InputBox onInput={setArgsStr} placeholder="-y @modelcontextprotocol/server-github" />
            </Show>

            <Show when={kind() === "remote"}>
              <box paddingTop={1}>
                <Label text="URL" />
              </box>
              <InputBox onInput={setUrl} placeholder="https://mcp.example.com/sse" />
            </Show>

            <box paddingTop={2} flexDirection="row">
              <box
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={busy() ? theme.borderSubtle : theme.primary}
                onMouseUp={submit}
              >
                <text fg={theme.background} attributes={TextAttributes.BOLD}>
                  {busy() ? "Adding…" : "→ Add server"}
                </text>
              </box>
            </box>
          </box>
        </Card>
      </box>
    </box>
  )
}
