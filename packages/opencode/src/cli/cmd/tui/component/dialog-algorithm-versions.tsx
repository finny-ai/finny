import { TextAttributes } from "@opentui/core"
import { createResource, For, Show } from "solid-js"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { Algorithm } from "@/algorithm"
import { DialogAlgorithmCode } from "./dialog-algorithm-code"

export interface DialogAlgorithmVersionsProps {
  algorithm: Algorithm.Info
}

// Lists every saved version of one algorithm. Lets the user click a version
// to open its full source in DialogAlgorithmCode. Closes on esc.
export function DialogAlgorithmVersions(props: DialogAlgorithmVersionsProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  const maxHeight = () => Math.floor(dimensions().height * 0.6)

  const [versions] = createResource(
    () => props.algorithm.algorithmId,
    (id) => Algorithm.listVersions(id),
  )

  let scrollRef: any
  useKeyboard((evt) => {
    // Escape closes — checked before the scrollRef guard so esc works even
    // before the scrollbox has mounted. The footer hint says "esc close",
    // but the original handler skipped this branch entirely (mouse-only).
    if (evt.name === "escape") {
      dialog.clear()
      evt.preventDefault()
      return
    }
    if (!scrollRef) return
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      scrollRef.scrollBy(-1)
      evt.preventDefault()
    }
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      scrollRef.scrollBy(1)
      evt.preventDefault()
    }
  })

  const formatDate = (ms: number) => {
    const d = new Date(ms)
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {props.algorithm.name} — versions
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Show
        when={!versions.loading}
        fallback={<text fg={theme.textMuted}>Loading versions…</text>}
      >
        <Show
          when={(versions() ?? []).length > 0}
          fallback={<text fg={theme.textMuted}>No versions found.</text>}
        >
          <text fg={theme.textMuted}>
            {(versions() ?? []).length} version{(versions() ?? []).length === 1 ? "" : "s"} · click one to view source
          </text>

          <scrollbox
            ref={(r: any) => (scrollRef = r)}
            maxHeight={maxHeight()}
            scrollbarOptions={{ visible: true }}
          >
            <box flexDirection="column" gap={1}>
              <For each={versions() ?? []}>
                {(v) => (
                  <box
                    flexDirection="column"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={theme.backgroundElement}
                    onMouseUp={() => DialogAlgorithmCode.show(dialog, v)}
                  >
                    <box flexDirection="row" gap={2}>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        v{v.version}
                      </text>
                      <text fg={theme.textMuted}>{v.status}</text>
                      <text fg={theme.textMuted}>{formatDate(v.time_updated)}</text>
                    </box>
                    <Show when={v.description}>
                      <text fg={theme.textMuted}>{v.description}</text>
                    </Show>
                  </box>
                )}
              </For>
            </box>
          </scrollbox>
        </Show>
      </Show>

      <text fg={theme.textMuted}>
        <span style={{ fg: theme.text }}>↑/↓</span> scroll · <span style={{ fg: theme.text }}>click</span> open ·{" "}
        <span style={{ fg: theme.text }}>esc</span> close
      </text>
    </box>
  )
}

DialogAlgorithmVersions.show = (dialog: DialogContext, algorithm: Algorithm.Info) => {
  dialog.setSize("large")
  dialog.replace(() => <DialogAlgorithmVersions algorithm={algorithm} />)
}
