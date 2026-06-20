import { createMemo, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useSync } from "../context/sync"
import { useRoute } from "../context/route"
import { Card } from "../component/card"
import { RouteHeader, ROUTE_ICONS } from "../component/route-header"
import { Locale } from "@/util/locale"

export function Sessions() {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()

  const sessions = createMemo(() => {
    const list = sync.data.session ?? []
    return list
      .filter((s) => s.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)
  })

  const grouped = createMemo(() => {
    const today = new Date().toDateString()
    const groups = new Map<string, typeof sessions extends () => infer U ? U : never>()
    for (const s of sessions()) {
      const date = new Date(s.time.updated).toDateString()
      const label = date === today ? "Today" : date
      const arr = (groups.get(label) as any) ?? []
      arr.push(s)
      groups.set(label, arr as any)
    }
    return Array.from(groups.entries())
  })

  return (
    <box flexGrow={1} flexDirection="column">
      <RouteHeader
        icon={ROUTE_ICONS.sessions as unknown as string[]}
        title="Sessions"
        subtitle="Your past conversations with Finny"
        meta={`${sessions().length} total`}
      />

      <box
        flexGrow={1}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={2}
        paddingBottom={2}
        flexDirection="column"
        minHeight={0}
      >
        <Card title=" Recent ">
          <Show
            when={sessions().length > 0}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
                <text fg={theme.textMuted}>No sessions yet.</text>
                <text fg={theme.textMuted}>Start a new conversation from the Home page.</text>
              </box>
            }
          >
            <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
              <box flexDirection="column" gap={1}>
                <For each={grouped()}>
                  {([label, items]) => (
                    <box flexDirection="column" gap={0} flexShrink={0}>
                      <box paddingLeft={1} paddingBottom={1}>
                        <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                          {label}
                        </text>
                      </box>
                      <For each={items as any}>
                        {(session: any) => {
                          const isActive = () =>
                            route.data.type === "session" && route.data.sessionID === session.id
                          return (
                            <box
                              flexDirection="row"
                              paddingLeft={1}
                              paddingRight={1}
                              onMouseUp={() =>
                                route.navigate({ type: "session", sessionID: session.id })
                              }
                            >
                              <text fg={isActive() ? theme.primary : theme.textMuted}>
                                {isActive() ? "▎ " : "  "}
                              </text>
                              <box flexGrow={1} flexDirection="column" minWidth={0}>
                                <text fg={theme.text} attributes={TextAttributes.BOLD}>
                                  {session.title || "Untitled session"}
                                </text>
                                <text fg={theme.textMuted}>{Locale.time(session.time.updated)}</text>
                              </box>
                            </box>
                          )
                        }}
                      </For>
                    </box>
                  )}
                </For>
              </box>
            </scrollbox>
          </Show>
        </Card>
      </box>
    </box>
  )
}
