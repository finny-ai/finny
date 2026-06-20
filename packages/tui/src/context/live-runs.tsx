import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import { LiveRunner } from "@/live/runner"
import type { Algorithm } from "@/algorithm"
import { createSimpleContext } from "./helper"

export const { use: useLiveRuns, provider: LiveRunsProvider } = createSimpleContext<
  {
    runs(): LiveRunner.Run[]
    get(id: string): LiveRunner.Run | undefined
    start(params: LiveRunner.StartParams): Promise<LiveRunner.Run>
    stop(id: string): Promise<void>
    remove(id: string): void
  },
  {}
>({
  name: "LiveRuns",
  init: () => {
    const [store, setStore] = createStore<{ runs: LiveRunner.Run[] }>({ runs: [] })

    const unsub = LiveRunner.subscribeAll((runs) => {
      setStore("runs", runs)
    })
    onCleanup(unsub)

    return {
      runs() {
        return store.runs
      },
      get(id: string) {
        return store.runs.find((r) => r.id === id) ?? LiveRunner.get(id)
      },
      async start(params: LiveRunner.StartParams) {
        return LiveRunner.start(params)
      },
      async stop(id: string) {
        await LiveRunner.stop(id)
      },
      remove(id: string) {
        LiveRunner.remove(id)
        setStore("runs", (rs) => rs.filter((r) => r.id !== id))
      },
    }
  },
})
