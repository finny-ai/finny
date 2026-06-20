import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useAlgorithms } from "../context/algorithms"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogStorage, type FinnyHomeInfo } from "./dialog-storage"

export function StorageCapsule() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const algorithms = useAlgorithms()
  const [info, setInfo] = createSignal<FinnyHomeInfo>()
  const [loaded, setLoaded] = createSignal(false)
  const visible = createMemo(() => {
    if (!loaded()) return false
    return info()?.source !== "env"
  })

  async function load() {
    try {
      const result = await sdk.client.config.finnyHome.get({}, { throwOnError: true })
      setInfo(result.data!)
    } catch (err) {
      toast.show({
        message: err instanceof Error ? err.message : "Failed to load Finny Home",
        variant: "error",
        duration: 4000,
      })
    } finally {
      setLoaded(true)
    }
  }

  onMount(() => {
    void load()
  })

  function open() {
    if (info()?.source === "env") return
    dialog.replace(() => (
      <DialogStorage
        initial={info()}
        onChange={(next) => {
          setInfo(next)
          algorithms.refetch()
        }}
      />
    ))
  }

  return (
    <Show when={visible()}>
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        border={["top", "right", "bottom", "left"]}
        borderColor={theme.border}
        onMouseUp={open}
      >
        <text fg={theme.text}>Workspace ▾</text>
      </box>
    </Show>
  )
}
