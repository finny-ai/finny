import { createMemo, For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { finnyProductMode } from "@/cloud-mode"
import { useTheme } from "../context/theme"
import { useRoute, type Route } from "../context/route"

type NavAction = { kind: "route"; type: Route["type"] }

type NavItem = {
  icon: string
  label: string
  action: NavAction
}

const TOP_ITEMS: NavItem[] = [
  { icon: "/^\\", label: "Home", action: { kind: "route", type: "home" } },
  { icon: "</>", label: "My Algos", action: { kind: "route", type: "algorithms" } },
  { icon: "▁▄█", label: "Backtest", action: { kind: "route", type: "backtests" } },
  { icon: "$$$", label: "Portfolio", action: { kind: "route", type: "portfolio" } },
  { icon: "≡≡≡", label: "Sessions", action: { kind: "route", type: "sessions" } },
]

const BOTTOM_ITEMS: NavItem[] = [
  { icon: "***", label: "Settings", action: { kind: "route", type: "settings" } },
]

function NavRow(props: { item: NavItem; isActive: boolean; onSelect: () => void }) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={1}
      paddingBottom={1}
      onMouseUp={props.onSelect}
    >
      <text fg={props.isActive ? theme.primary : theme.textMuted} attributes={TextAttributes.BOLD}>
        {props.isActive ? "▎" : " "}
      </text>
      <text fg={props.isActive ? theme.primary : theme.textMuted} attributes={TextAttributes.BOLD}>
        {"  " + props.item.icon + "   "}
      </text>
      <text
        fg={props.isActive ? theme.text : theme.text}
        attributes={TextAttributes.BOLD}
      >
        {props.item.label}
      </text>
    </box>
  )
}

export function SidebarNav() {
  const { theme } = useTheme()
  const route = useRoute()
  const productMode = finnyProductMode()
  const productLabel = productMode === "cloud" ? "CLOUD" : productMode === "enterprise" ? "ENTERPRISE" : undefined

  const activeType = createMemo(() => {
    const t = route.data.type
    return t === "session" ? "sessions" : t
  })

  const runAction = (item: NavItem) => {
    if (item.action.kind === "route") {
      const type = item.action.type
      if (type === "home") route.navigate({ type: "home" })
      else if (type === "algorithms") route.navigate({ type: "algorithms" })
      else if (type === "backtests") route.navigate({ type: "backtests" })
      else if (type === "portfolio") route.navigate({ type: "portfolio" })
      else if (type === "sessions") route.navigate({ type: "sessions" })
      else if (type === "settings") route.navigate({ type: "settings" })
      return
    }
  }

  const isActive = (item: NavItem) => {
    return activeType() === item.action.type
  }

  return (
    <box
      width={32}
      flexShrink={0}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      border={["right"]}
      borderColor={theme.border}
    >
      {/* Brand header - click FINNY to open Portfolio Builder. */}
      <box paddingLeft={3} paddingRight={3} paddingTop={2} paddingBottom={2} flexShrink={0}>
        <box flexDirection="row" gap={1}>
          <box flexShrink={0} onMouseUp={() => route.navigate({ type: "portfolio-builder" })}>
            <text fg={theme.primary} attributes={TextAttributes.BOLD}>
              FINNY
            </text>
          </box>
          {productLabel && (
            <text fg="#00cab4" attributes={TextAttributes.BOLD}>
              {productLabel}
            </text>
          )}
        </box>
        <text fg={theme.textMuted} selectable={false}>
          Financial AI Harness
        </text>
      </box>

      <box flexDirection="column" flexShrink={0} paddingTop={1}>
        <For each={TOP_ITEMS}>
          {(item) => (
            <NavRow item={item} isActive={isActive(item)} onSelect={() => runAction(item)} />
          )}
        </For>
      </box>

      <box flexGrow={1} minHeight={0} />

      <box paddingLeft={3} paddingRight={3} paddingBottom={1} flexShrink={0}>
        <text fg={theme.border}>──────────────────────</text>
      </box>
      <box flexDirection="column" flexShrink={0} paddingBottom={2}>
        {/* Upgrade and Discord are hidden for the enterprise build. */}
        <For each={BOTTOM_ITEMS}>
          {(item) => (
            <NavRow item={item} isActive={isActive(item)} onSelect={() => runAction(item)} />
          )}
        </For>
      </box>
    </box>
  )
}
