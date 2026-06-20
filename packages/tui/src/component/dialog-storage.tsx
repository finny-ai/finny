import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { useClipboard } from "../context/clipboard"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useTuiPaths, useTuiTerminalEnvironment } from "../context/runtime"
import { abbreviateHome } from "../runtime"
import { chooseDirectoryLabel, chooseDirectoryWithFileManager, fileManagerName } from "../util/file-manager"
import { errorMessage } from "../util/error"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

export type FinnyHomeInfo = {
  path: string
  source: "env" | "prefs" | "default"
  configurable: boolean
  defaultPath: string
  prefsPath: string
  artifacts: {
    algos: string
    sessionWorkspaces: string
    pythonEnv: string
    algorithms: string
  }
}

type StorageAction = "choose" | "manual" | "default" | "copy"

export function formatFinnyHomePath(input: string | undefined, home: string, max = 30): string {
  if (!input) return "..."
  const value = abbreviateHome(input, home)
  if (value.length <= max) return value
  return "..." + value.slice(-(max - 3))
}

function sourceLabel(info: FinnyHomeInfo) {
  if (info.source === "env") return "Set by FINNY_HOME"
  if (info.source === "prefs") return "Saved preference"
  return "Default location"
}

export function DialogStorage(props: { initial?: FinnyHomeInfo; onChange?: (info: FinnyHomeInfo) => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const clipboard = useClipboard()
  const { theme } = useTheme()
  const paths = useTuiPaths()
  const terminal = useTuiTerminalEnvironment()
  const [loaded, setLoaded] = createSignal<FinnyHomeInfo | undefined>(props.initial)

  const info = createMemo(() => loaded())
  const shortPath = createMemo(() => formatFinnyHomePath(info()?.path, paths.home, 48))

  async function load() {
    try {
      const result = await sdk.client.config.finnyHome.get({}, { throwOnError: true })
      const next = result.data!
      setLoaded(next)
      props.onChange?.(next)
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : "Failed to load Finny Home",
        variant: "error",
        duration: 5000,
      })
    }
  }

  onMount(() => {
    if (!props.initial) void load()
  })

  async function refresh(next: FinnyHomeInfo) {
    props.onChange?.(next)
    dialog.replace(() => <DialogStorage initial={next} onChange={props.onChange} />)
  }

  async function saveHome(current: FinnyHomeInfo, value: string, options: { reopenDialog?: boolean } = {}) {
    try {
      const result = await sdk.client.config.finnyHome.update({ body: { path: value } }, { throwOnError: true })
      const next = result.data!
      toast.show({
        message: `Using ${formatFinnyHomePath(next.path, paths.home, 48)}`,
        variant: "success",
        duration: 3000,
      })
      if (options.reopenDialog === false) {
        setLoaded(next)
        props.onChange?.(next)
      } else {
        await refresh(next)
      }
    } catch (err) {
      toast.show({
        message: errorMessage(err),
        variant: "error",
        duration: 5000,
      })
      if (options.reopenDialog !== false) {
        dialog.replace(() => <DialogStorage initial={current} onChange={props.onChange} />)
      }
    }
  }

  async function chooseHome(current: FinnyHomeInfo) {
    dialog.clear()
    try {
      const value = await chooseDirectoryWithFileManager({ currentPath: current.path, platform: terminal.platform })
      if (!value) return
      await saveHome(current, value, { reopenDialog: false })
    } catch {
      toast.show({
        message: `Could not open ${fileManagerName({ platform: terminal.platform })} picker; enter a path manually`,
        variant: "warning",
        duration: 5000,
      })
      await changeHomeManually(current)
    }
  }

  async function changeHomeManually(current: FinnyHomeInfo) {
    const value = await DialogPrompt.show(dialog, "Change Finny Home", {
      value: current.path,
      placeholder: "/path/to/finny",
      description: () => (
        <text fg={theme.textMuted}>
          Finny will create the directory and use it for algos, saved algorithms, and Python envs.
        </text>
      ),
    })
    if (value === null) return

    await saveHome(current, value)
  }

  async function useDefault(current: FinnyHomeInfo) {
    try {
      const result = await sdk.client.config.finnyHome.update({ body: { path: null } }, { throwOnError: true })
      const next = result.data!
      toast.show({
        message: `Using default: ${formatFinnyHomePath(next.path, paths.home, 48)}`,
        variant: "info",
        duration: 3000,
      })
      await refresh(next)
    } catch (err) {
      toast.show({
        message: errorMessage(err),
        variant: "error",
        duration: 5000,
      })
      dialog.replace(() => <DialogStorage initial={current} onChange={props.onChange} />)
    }
  }

  async function copyPath(current: FinnyHomeInfo) {
    try {
      await clipboard.write?.(current.path)
      toast.show({ message: "Finny Home path copied", variant: "info", duration: 3000 })
    } catch {
      toast.show({ message: "Failed to copy Finny Home path", variant: "error", duration: 3000 })
    }
  }

  const options = createMemo<DialogSelectOption<StorageAction>[]>(() => {
    const current = info()
    if (!current) {
      return [
        {
          title: "Loading storage settings...",
          value: "copy",
          description: "Fetching Finny Home",
        },
      ]
    }

    const result: DialogSelectOption<StorageAction>[] = []
    if (current.configurable) {
      result.push({
        title: chooseDirectoryLabel({ platform: terminal.platform }),
        value: "choose",
        description: "Select where the Finny folder should live",
      })
    }
    if (current.configurable) {
      result.push({
        title: "Enter path manually",
        value: "manual",
        description: "Type or paste an absolute path",
      })
      if (current.source !== "default") {
        result.push({
          title: "Use default",
          value: "default",
          description: formatFinnyHomePath(current.defaultPath, paths.home, 52),
        })
      }
    }
    result.push({
      title: "Copy path",
      value: "copy",
      description: current.path,
    })
    return result
  })

  function select(option: DialogSelectOption<StorageAction>) {
    const current = info()
    if (!current) return
    if (option.value === "choose") void chooseHome(current)
    if (option.value === "manual") void changeHomeManually(current)
    if (option.value === "default") void useDefault(current)
    if (option.value === "copy") void copyPath(current)
  }

  return (
    <DialogSelect
      title="Finny Home"
      titleView={
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Finny Home
          </text>
          <Show when={info()}>
            {(current) => (
              <box flexDirection="column">
                <text fg={theme.textMuted}>{shortPath()}</text>
                <text fg={current().configurable ? theme.textMuted : theme.warning}>{sourceLabel(current())}</text>
              </box>
            )}
          </Show>
        </box>
      }
      skipFilter
      renderFilter={false}
      options={options()}
      onSelect={select}
      footer={
        <Show when={info()}>
          {(current) => (
            <box flexDirection="column" gap={0}>
              <text fg={theme.textMuted}>Artifacts</text>
              <For
                each={[
                  ["algos", current().artifacts.algos],
                  ["algorithms", current().artifacts.algorithms],
                  ["python-env", current().artifacts.pythonEnv],
                  ["session-workspaces", current().artifacts.sessionWorkspaces],
                ]}
              >
                {([label, value]) => (
                  <text fg={theme.textMuted}>
                    {label}: {formatFinnyHomePath(value, paths.home, 56)}
                  </text>
                )}
              </For>
              <text fg={theme.textMuted}>prefs: {formatFinnyHomePath(current().prefsPath, paths.home, 56)}</text>
            </box>
          )}
        </Show>
      }
    />
  )
}
