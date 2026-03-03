import { createSignal, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { Algorithm } from "@/algorithm"
import { useTheme } from "../context/theme"

export interface DialogAlgorithmListProps {
  title: string
  algorithms: Algorithm.Info[]
  onSelect: (algo: Algorithm.Info) => void
}

export function DialogAlgorithmList(props: DialogAlgorithmListProps) {
  const options = () =>
    props.algorithms.map(
      (algo): DialogSelectOption<Algorithm.Info> => ({
        title: algo.name,
        value: algo,
        description: algo.description,
        footer: `v${algo.version} · ${algo.status}`,
        category: algo.status === "deployed" ? "Deployed" : "Draft",
      }),
    )

  return (
    <Show
      when={props.algorithms.length > 0}
      fallback={
        <NoAlgorithms title={props.title} />
      }
    >
      <DialogSelect
        title={props.title}
        placeholder="Search algorithms..."
        options={options()}
        onSelect={(opt) => props.onSelect(opt.value)}
      />
    </Show>
  )
}

function NoAlgorithms(props: { title: string }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text}>{props.title}</text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>esc</text>
      </box>
      <text fg={theme.textMuted}>No algorithms found. Use /build to create one.</text>
    </box>
  )
}

DialogAlgorithmList.show = async (dialog: DialogContext, title: string): Promise<Algorithm.Info | null> => {
  let algorithms: Algorithm.Info[]
  try {
    algorithms = await Promise.race([
      Algorithm.list(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ])
  } catch {
    algorithms = []
  }

  return new Promise<Algorithm.Info | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogAlgorithmList
          title={title}
          algorithms={algorithms}
          onSelect={(algo) => resolve(algo)}
        />
      ),
      () => resolve(null),
    )
  })
}
