import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { TextAttributes, type KeyBinding, type TextareaRenderable } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useProject } from "../context/project"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { Card } from "./card"
import { SettingsPanelPaperTrading } from "./settings-panel-paper-trading"
import { SettingsPanelWebSearch } from "./settings-panel-websearch"
import { SettingsPanelQuantConnect } from "./settings-panel-quantconnect"

type DataAgentInstructions = {
  path: "data-agent/instructions.md"
  absolute_path: string
  content: string
  exists: boolean
}

type DataSourceSection = "instructions" | "brokerages" | "websearch" | "quantconnect"

const DATA_AGENT_INSTRUCTIONS_PATH = "data-agent/instructions.md"
const SECTIONS: { id: DataSourceSection; label: string; description: string }[] = [
  {
    id: "instructions",
    label: "Instructions",
    description: "Data Agent cookbook",
  },
  {
    id: "brokerages",
    label: "Brokerages",
    description: "Connected accounts",
  },
  {
    id: "websearch",
    label: "Web search",
    description: "Perplexity API key",
  },
  {
    id: "quantconnect",
    label: "QuantConnect",
    description: "Mode, credentials, deployments",
  },
]

export function SettingsPanelDataSources(props: { initialSection?: DataSourceSection }) {
  const { theme } = useTheme()
  const [section, setSection] = createSignal<DataSourceSection>(props.initialSection ?? "instructions")

  createEffect(() => {
    setSection(props.initialSection ?? "instructions")
  })

  return (
    <box flexGrow={1} flexDirection="row" gap={2} minHeight={0}>
      <box width={28} flexShrink={0} minHeight={0}>
        <Card title=" Data Sources ">
          <box flexDirection="column" gap={1}>
            <For each={SECTIONS}>
              {(item) => {
                const active = () => section() === item.id
                return (
                  <box
                    flexDirection="column"
                    paddingLeft={1}
                    paddingRight={1}
                    paddingTop={1}
                    paddingBottom={1}
                    backgroundColor={active() ? theme.backgroundElement : undefined}
                    border={active() ? ["left"] : undefined}
                    borderColor={active() ? theme.primary : undefined}
                    onMouseUp={() => setSection(item.id)}
                  >
                    <text fg={active() ? theme.primary : theme.text} attributes={TextAttributes.BOLD}>
                      {item.label}
                    </text>
                    <text fg={theme.textMuted}>{item.description}</text>
                  </box>
                )
              }}
            </For>
          </box>
        </Card>
      </box>

      <box flexGrow={1} minHeight={0}>
        <Show when={section() === "instructions"}>
          <DataAgentInstructionsPanel />
        </Show>
        <Show when={section() === "brokerages"}>
          <SettingsPanelPaperTrading />
        </Show>
        <Show when={section() === "websearch"}>
          <SettingsPanelWebSearch />
        </Show>
        <Show when={section() === "quantconnect"}>
          <SettingsPanelQuantConnect />
        </Show>
      </box>
    </box>
  )
}

function DataAgentInstructionsPanel() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast()

  let textarea: TextareaRenderable | undefined

  const [instructions, setInstructions] = createSignal<DataAgentInstructions>()
  const [content, setContent] = createSignal("")
  const [editing, setEditing] = createSignal(false)
  const [busy, setBusy] = createSignal<"loading" | "saving">()
  const [error, setError] = createSignal<string>()

  // The TUI textarea ships sensible defaults; only remap return so editing the
  // cookbook inserts newlines instead of submitting.
  const editorKeybindings = createMemo<KeyBinding[]>(() => [{ name: "return", action: "newline" as const }])
  const dirty = createMemo(() => content() !== (instructions()?.content ?? ""))
  const pathLabel = createMemo(() => instructions()?.path ?? DATA_AGENT_INSTRUCTIONS_PATH)
  const absolutePath = createMemo(() => instructions()?.absolute_path ?? "")

  async function request(method: "GET" | "PUT", body?: { content: string }) {
    const directory = project.instance.directory() || sdk.directory
    if (!directory) throw new Error("Open a project before editing Data Agent instructions.")

    const url = new URL("/config/data-agent-instructions", sdk.url)
    const headers = new Headers(sdk.headers)
    headers.set("accept", "application/json")
    headers.set("x-opencode-directory", encodeURIComponent(directory))
    if (body) headers.set("content-type", "application/json")

    const response = await sdk.fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || response.statusText)
    }
    return response.json() as Promise<DataAgentInstructions>
  }

  async function load() {
    if (busy()) return
    setBusy("loading")
    try {
      const next = await request("GET")
      setInstructions(next)
      setContent(next.content)
      setError(undefined)
      if (textarea && !textarea.isDestroyed) textarea.setText(next.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  function beginEdit() {
    if (busy() || error()) return
    setEditing(true)
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.setText(content())
      textarea.focus()
    }, 1)
  }

  function cancelEdit() {
    const original = instructions()?.content ?? ""
    setContent(original)
    if (textarea && !textarea.isDestroyed) textarea.setText(original)
    setEditing(false)
  }

  async function save() {
    if (busy()) return
    const nextContent = textarea && !textarea.isDestroyed ? textarea.plainText : content()
    setBusy("saving")
    try {
      const next = await request("PUT", { content: nextContent })
      setInstructions(next)
      setContent(next.content)
      setError(undefined)
      setEditing(false)
      toast.show({ message: "Updated data-agent/instructions.md", variant: "success", duration: 3000 })
    } catch (err) {
      toast.show({
        message: `Failed to save Data Agent instructions: ${err instanceof Error ? err.message : String(err)}`,
        variant: "error",
        duration: 5000,
      })
    } finally {
      setBusy(undefined)
    }
  }

  onMount(() => {
    void load()
  })

  const Action = (props: {
    label: string
    disabled?: boolean
    primary?: boolean
    onClick: () => void
  }) => (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.primary && !props.disabled ? theme.backgroundElement : undefined}
      onMouseUp={() => {
        if (!props.disabled) props.onClick()
      }}
    >
      <text
        fg={props.disabled ? theme.textMuted : props.primary ? theme.primary : theme.textMuted}
        attributes={TextAttributes.BOLD}
      >
        {props.label}
      </text>
    </box>
  )

  return (
    <Card title=" Data Agent instructions " flexGrow={1}>
      <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
        <box flexDirection="row" justifyContent="space-between" gap={2} flexShrink={0}>
          <box flexDirection="column" flexGrow={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Source cookbook
            </text>
            <text fg={theme.textMuted}>Connection recipes used by the data_extractor subagent.</text>
          </box>
          <box flexDirection="row" gap={2} flexShrink={0}>
            <Show
              when={editing()}
              fallback={
                <Action
                  label={busy() === "loading" ? "Loading..." : "Edit instructions"}
                  disabled={!!busy() || !!error()}
                  primary
                  onClick={beginEdit}
                />
              }
            >
              <Action label="Cancel" disabled={!!busy()} onClick={cancelEdit} />
              <Action
                label={busy() === "saving" ? "Saving..." : "Save changes"}
                disabled={!!busy() || !dirty()}
                primary
                onClick={() => void save()}
              />
            </Show>
          </box>
        </box>

        <box flexDirection="column" gap={0} flexShrink={0} paddingTop={1}>
          <box flexDirection="row" gap={2}>
            <text fg={theme.textMuted}>path</text>
            <text fg={theme.text}>{pathLabel()}</text>
            <Show when={instructions()?.exists === false}>
              <text fg={theme.warning}>will be created on save</text>
            </Show>
            <Show when={dirty()}>
              <text fg={theme.warning}>modified</text>
            </Show>
          </box>
          <Show when={absolutePath()}>
            <text fg={theme.textMuted}>{absolutePath()}</text>
          </Show>
        </box>

        <Show
          when={!error()}
          fallback={
            <box
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
              backgroundColor={theme.backgroundElement}
            >
              <text fg={theme.error}>Failed to load Data Agent instructions: {error()}</text>
            </box>
          }
        >
          <Show
            when={editing()}
            fallback={
              <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
                <box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
                  <text fg={content() ? theme.text : theme.textMuted}>
                    {content() || "No instructions yet. Choose Edit to create data-agent/instructions.md."}
                  </text>
                </box>
              </scrollbox>
            }
          >
            <box
              flexGrow={1}
              minHeight={0}
              backgroundColor={theme.backgroundElement}
              paddingLeft={1}
              paddingRight={1}
            >
              <textarea
                ref={(val: TextareaRenderable) => {
                  textarea = val
                  val.setText(content())
                }}
                initialValue={content()}
                placeholder="Data Agent source instructions"
                placeholderColor={theme.textMuted}
                textColor={busy() ? theme.textMuted : theme.text}
                focusedTextColor={busy() ? theme.textMuted : theme.text}
                cursorColor={busy() ? theme.backgroundElement : theme.primary}
                minHeight={12}
                maxHeight={24}
                keyBindings={editorKeybindings()}
                onContentChange={() => {
                  if (!textarea || textarea.isDestroyed) return
                  setContent(textarea.plainText)
                }}
              />
            </box>
          </Show>
        </Show>
      </box>
    </Card>
  )
}
