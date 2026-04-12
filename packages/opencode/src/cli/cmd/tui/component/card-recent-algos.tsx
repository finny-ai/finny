import { For, Show, createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useAlgorithms } from "../context/algorithms"
import { useRoute } from "../context/route"
import { Card } from "./card"

export function RecentAlgosCard() {
  const { theme } = useTheme()
  const algos = useAlgorithms()
  const route = useRoute()
  const top = createMemo(() => {
    const list = algos.data() ?? []
    return [...list].sort((a, b) => b.time_updated - a.time_updated).slice(0, 4)
  })

  return (
    <Card title=" Recent algorithms ">
      <Show
        when={top().length > 0}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center" gap={1}>
            <text fg={theme.textMuted}>No algorithms yet.</text>
            <text fg={theme.textMuted}>
              Describe a strategy <span style={{ fg: theme.primary }}>above</span> and it'll show up here.
            </text>
          </box>
        }
      >
        <box flexDirection="column" gap={1}>
          <For each={top()}>
            {(algo) => (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                onMouseUp={() => route.navigate({ type: "algorithms" })}
              >
                <box flexGrow={1} flexDirection="column" minWidth={0}>
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>
                    {algo.name}
                  </text>
                  <text fg={theme.textMuted}>
                    v{algo.version} · {algo.status}
                  </text>
                </box>
              </box>
            )}
          </For>
        </box>
      </Show>
    </Card>
  )
}
