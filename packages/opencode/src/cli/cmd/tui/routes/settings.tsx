import { createMemo, For, Show, type JSX } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useRoute, type SettingsTab } from "../context/route"
import { useDialog } from "../ui/dialog"
import { Card } from "../component/card"
import { RouteHeader, ROUTE_ICONS } from "../component/route-header"
import { DialogThemeList } from "../component/dialog-theme-list"
import { DialogModel } from "../component/dialog-model"
import { DialogProvider as DialogProviderList } from "../component/dialog-provider"
import { DialogAgent } from "../component/dialog-agent"
import { SettingsPanelMcp } from "../component/settings-panel-mcp"
import { SettingsPanelPaperTrading } from "../component/settings-panel-paper-trading"
import { SettingsPanelSkills } from "../component/settings-panel-skills"
import { SettingsPanelPro } from "../component/settings-panel-pro"

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "paper-trading", label: "Brokerages" },
  { id: "mcp", label: "MCP" },
  { id: "skills", label: "Skills" },
  { id: "pro", label: "Plan" },
]

type SimpleCopy = { title: string; body: string; cta: string }
const COPY: Record<Exclude<SettingsTab, "mcp" | "paper-trading" | "skills" | "pro">, SimpleCopy> = {
  appearance: {
    title: "Appearance",
    body: "Theme and display preferences for the Finny TUI.",
    cta: "Open theme picker",
  },
  model: {
    title: "Model",
    body: "Choose the LLM that powers Research and Chat modes.",
    cta: "Open model picker",
  },
  providers: {
    title: "Providers",
    body: "Connect API keys for OpenAI, Anthropic, GitHub Copilot, and more.",
    cta: "Manage providers",
  },
  agents: {
    title: "Agents",
    body: "Configure Research and Chat modes and their permissions.",
    cta: "Open agent picker",
  },
}

export function Settings() {
  const { theme } = useTheme()
  const route = useRoute()
  const dialog = useDialog()

  const activeTab = createMemo<SettingsTab>(() => {
    const data = route.data
    if (data.type !== "settings") return "appearance"
    return data.tab ?? "appearance"
  })

  const openDialog = () => {
    const tab = activeTab()
    const view: Partial<Record<SettingsTab, () => JSX.Element>> = {
      appearance: () => <DialogThemeList />,
      model: () => <DialogModel />,
      providers: () => <DialogProviderList />,
      agents: () => <DialogAgent />,
    }
    const render = view[tab]
    if (render) dialog.replace(render)
  }

  const isSimpleTab = (t: SettingsTab): t is Exclude<SettingsTab, "mcp" | "paper-trading" | "skills" | "pro"> =>
    t !== "mcp" && t !== "paper-trading" && t !== "skills" && t !== "pro"

  return (
    <box flexGrow={1} flexDirection="column">
      <RouteHeader
        icon={ROUTE_ICONS.settings as unknown as string[]}
        title="Settings"
        subtitle="Appearance, MCP, skills, brokerages, plan"
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
        {/* Tabs */}
        <box flexDirection="row" gap={4} flexShrink={0}>
          <For each={TABS}>
            {(tab) => {
              const isActive = () => activeTab() === tab.id
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  paddingBottom={1}
                  border={["bottom"]}
                  borderColor={isActive() ? theme.primary : theme.background}
                  onMouseUp={() => route.navigate({ type: "settings", tab: tab.id })}
                >
                  <text
                    fg={isActive() ? theme.text : theme.textMuted}
                    attributes={isActive() ? TextAttributes.BOLD : 0}
                  >
                    {tab.label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>

        {/* Panel body */}
        <box flexGrow={1} minHeight={0}>
          <Show when={activeTab() === "mcp"}>
            <SettingsPanelMcp />
          </Show>
          <Show when={activeTab() === "paper-trading"}>
            <SettingsPanelPaperTrading />
          </Show>
          <Show when={activeTab() === "skills"}>
            <SettingsPanelSkills />
          </Show>
          <Show when={activeTab() === "pro"}>
            <SettingsPanelPro />
          </Show>
          <Show when={isSimpleTab(activeTab())}>
            <Card title={` ${COPY[activeTab() as Exclude<SettingsTab, "mcp" | "paper-trading" | "skills" | "pro">].title} `}>
              <box flexDirection="column" gap={2}>
                <text fg={theme.textMuted}>
                  {COPY[activeTab() as Exclude<SettingsTab, "mcp" | "paper-trading" | "skills" | "pro">].body}
                </text>
                <box
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={1}
                  paddingBottom={1}
                  backgroundColor={theme.primary}
                  onMouseUp={openDialog}
                >
                  <text fg={theme.background} attributes={TextAttributes.BOLD}>
                    → {COPY[activeTab() as Exclude<SettingsTab, "mcp" | "paper-trading" | "skills" | "pro">].cta}
                  </text>
                </box>
              </box>
            </Card>
          </Show>
        </box>
      </box>
    </box>
  )
}
