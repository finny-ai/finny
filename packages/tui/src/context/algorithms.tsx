import { createResource, createSignal, onCleanup, type Resource } from "solid-js"
import { Algorithm } from "@/algorithm"
import { createSimpleContext } from "./helper"
import { useEvent } from "./event"

type AlgorithmsState = {
  data: Resource<Algorithm.Info[]>
  refetch: () => void
}

export const { use: useAlgorithms, provider: AlgorithmsProvider } = createSimpleContext<AlgorithmsState, {}>({
  name: "Algorithms",
  init: () => {
    const event = useEvent()
    const [tick, setTick] = createSignal(0)
    const [data] = createResource(
      tick,
      async () => {
        try {
          return await Promise.race([
            Algorithm.list(),
            new Promise<Algorithm.Info[]>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), 5000),
            ),
          ])
        } catch {
          return []
        }
      },
      { initialValue: [] },
    )
    const unsubscribe = event.subscribe((rawEvt) => {
      const type = (rawEvt as { type?: string }).type
      if (
        type === "algorithm.saved" ||
        type === "algorithm.removed" ||
        type === "algorithm.config_patched"
      ) {
        setTick((t) => t + 1)
      }
    })
    onCleanup(() => unsubscribe())
    return {
      data,
      refetch: () => setTick((t) => t + 1),
    }
  },
})
