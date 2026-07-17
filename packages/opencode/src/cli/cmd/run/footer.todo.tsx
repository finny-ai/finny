/** @jsxImportSource @opentui/solid */
import { For, Show, createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import type { RunTheme } from "./theme"
import type { ToolTodoSnapshot } from "./types"

const PANEL_LIMIT = 6

function mark(status: string) {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "•"
  if (status === "cancelled") return "×"
  return " "
}

function itemColor(theme: RunTheme["footer"], status: string) {
  if (status === "in_progress") return theme.warning
  if (status === "completed" || status === "cancelled") return theme.muted
  return theme.text
}

export function createFooterTodoTray(input: { todo: Accessor<ToolTodoSnapshot>; canExpand: Accessor<boolean> }) {
  const [open, setOpen] = createSignal(false)
  const count = createMemo(() => input.todo().items.length)
  const completed = createMemo(() => input.todo().items.filter((item) => item.status === "completed").length)
  const hasTodos = createMemo(() => count() > 0)
  const expanded = createMemo(() => open() && hasTodos() && input.canExpand())
  const rows = createMemo(() => {
    if (!expanded()) return 0
    const visible = Math.min(PANEL_LIMIT, count())
    return visible + (count() > visible ? 1 : 0) + 3
  })

  createEffect(() => {
    if (!hasTodos()) setOpen(false)
  })

  return {
    todo: input.todo,
    open,
    count,
    completed,
    hasTodos,
    expanded,
    rows,
    toggle: () => setOpen((value) => !value),
    close: () => setOpen(false),
  }
}

export type FooterTodoTray = ReturnType<typeof createFooterTodoTray>

export function RunTodoPanel(props: {
  tray: FooterTodoTray
  theme: Accessor<RunTheme["footer"]>
  width: Accessor<number>
}) {
  const visible = createMemo(() => props.tray.todo().items.slice(0, PANEL_LIMIT))
  const hidden = createMemo(() => Math.max(0, props.tray.count() - visible().length))

  return (
    <box
      id="run-direct-footer-todo-panel-row"
      width="100%"
      flexDirection="row"
      justifyContent="flex-end"
      paddingRight={1}
    >
      <box
        id="run-direct-footer-todo-panel"
        width={Math.max(28, Math.min(58, props.width() - 2))}
        flexDirection="column"
        border={["top", "right", "bottom", "left"]}
        borderColor={props.theme().muted}
        backgroundColor={props.theme().surface}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" justifyContent="space-between" onMouseDown={props.tray.close}>
          <text fg={props.theme().text} attributes={1}>
            ▼ Tasks
          </text>
          <text fg={props.theme().muted}>
            {props.tray.completed()}/{props.tray.count()}
          </text>
        </box>
        <For each={visible()}>
          {(item) => (
            <text fg={itemColor(props.theme(), item.status)} wrapMode="none" truncate>
              [{mark(item.status)}] {item.content}
            </text>
          )}
        </For>
        <Show when={hidden() > 0}>
          <text fg={props.theme().muted}>+{hidden()} more</text>
        </Show>
      </box>
    </box>
  )
}

export function RunTodoStatus(props: {
  tray: FooterTodoTray
  theme: Accessor<RunTheme["footer"]>
  separated: Accessor<boolean>
}) {
  return (
    <Show when={props.tray.hasTodos()}>
      <box
        id="run-direct-footer-statusline-todo-tray"
        paddingRight={1}
        backgroundColor="transparent"
        flexShrink={0}
        onMouseDown={props.tray.toggle}
      >
        <text fg={props.theme().text} wrapMode="none">
          <Show when={props.separated()}>
            <span style={{ fg: props.theme().muted }}>· </span>
          </Show>
          <span style={{ fg: props.theme().warning }}>{props.tray.open() ? "▼" : "▶"} </span>
          <span style={{ fg: props.theme().text }}>
            Tasks {props.tray.completed()}/{props.tray.count()}
          </span>
        </text>
      </box>
    </Show>
  )
}
