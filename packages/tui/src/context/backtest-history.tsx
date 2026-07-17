import crypto from "crypto"
import type { BacktestRunner } from "@/backtest/runner"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"

export type BacktestHistoryEntry = {
  id: string
  algorithmId: string
  algorithmName: string
  params: {
    duration: string
    interval: string
    capital: string
  }
  results: BacktestRunner.Results
  symbol?: string
  timestamp: number
}

const KV_KEY = "backtest_history"
const MAX_ENTRIES = 50

export const { use: useBacktestHistory, provider: BacktestHistoryProvider } = createSimpleContext<
  {
    list(): BacktestHistoryEntry[]
    add(entry: Omit<BacktestHistoryEntry, "id" | "timestamp">): BacktestHistoryEntry
    get(id: string): BacktestHistoryEntry | undefined
    remove(id: string): void
    clear(): void
  },
  {}
>({
  name: "BacktestHistory",
  init: () => {
    const kv = useKV()

    const read = (): BacktestHistoryEntry[] => {
      const raw = kv.get(KV_KEY, [])
      return Array.isArray(raw) ? raw : []
    }

    const write = (next: BacktestHistoryEntry[]) => {
      kv.set(KV_KEY, next)
    }

    return {
      list(): BacktestHistoryEntry[] {
        return [...read()].sort((a, b) => b.timestamp - a.timestamp)
      },
      add(entry: Omit<BacktestHistoryEntry, "id" | "timestamp">): BacktestHistoryEntry {
        const full: BacktestHistoryEntry = {
          ...entry,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
        }
        const current = read()
        const next = [full, ...current].slice(0, MAX_ENTRIES)
        write(next)
        return full
      },
      get(id: string): BacktestHistoryEntry | undefined {
        return read().find((e) => e.id === id)
      },
      remove(id: string) {
        write(read().filter((e) => e.id !== id))
      },
      clear() {
        write([])
      },
    }
  },
})
