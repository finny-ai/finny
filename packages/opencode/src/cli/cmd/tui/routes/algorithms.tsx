import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { BacktestRunner } from "@/backtest/runner"
import { Algorithm } from "@/algorithm"
import { parseConfig } from "@/algorithm/strategy-params"
import { useTheme } from "../context/theme"
import { useAlgorithms } from "../context/algorithms"
import { useBacktestHistory } from "../context/backtest-history"
import { useLiveRuns } from "../context/live-runs"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { Card } from "../component/card"
import { AlgorithmCodeView } from "../component/algorithm-code-view"
import { RouteHeader, ROUTE_ICONS } from "../component/route-header"
import { DialogBacktestParams } from "../component/dialog-backtest-params"
import { DialogBacktestRunning } from "../component/dialog-backtest-running"
import { DialogBacktestResults } from "../component/dialog-backtest-results"
import { DialogLiveConfirm } from "../component/dialog-live-confirm"
import { DialogLiveRun } from "../component/dialog-live-run"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogManagedHosting } from "../component/dialog-managed-hosting"
import { DialogProUpsell } from "../component/dialog-pro-upsell"
import { Plan } from "@/plan"

export function Algorithms() {
  const { theme } = useTheme()
  const algos = useAlgorithms()
  const history = useBacktestHistory()
  const liveRuns = useLiveRuns()
  const dialog = useDialog()
  const toast = useToast()
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)
  const [tier, setTier] = createSignal<Plan.Tier>("free")

  // Always refetch on route mount so newly-built algos show up.
  onMount(async () => {
    algos.refetch()
    setTier(await Plan.getTier())
  })

  const guessSymbolForAlgo = (algo: Algorithm.Info): string => {
    const params = parseConfig(algo.config)
    if (params.symbol) return params.symbol
    const code = algo.code || ""
    const m1 = code.match(/SYMBOL\s*=\s*["']([^"']+)["']/)
    if (m1) return m1[1]
    const stop = new Set([
      "INTRADAY", "HYBRID", "MOMENTUM", "MEAN", "REVERSION", "BREAKOUT",
      "STRATEGY", "ALGO", "V1", "V2", "V3", "V4", "V5",
    ])
    for (const t of (algo.name || "").toUpperCase().split(/[-_\s.]+/)) {
      if (!t || stop.has(t)) continue
      if (/^[A-Z][A-Z0-9]{0,4}$/.test(t)) return t
    }
    return "AAPL"
  }

  const guessIntervalForAlgo = (algo: Algorithm.Info): string => {
    const params = parseConfig(algo.config)
    if (params.interval) return params.interval
    const m = (algo.code || "").match(/INTERVAL\s*=\s*["']([^"']+)["']/)
    if (m) return m[1]
    return "1min"
  }

  const runLive = async (algo: Algorithm.Info) => {
    // Local terminal live run. The runner enforces per-tier simultaneous caps;
    // broker-specific tier checks still apply before real brokerage access.
    const liveCfg = parseConfig(algo.config)
    const liveEquity = liveCfg.equity_usd ?? liveCfg.risk?.starting_equity_usd
    const params = await DialogLiveConfirm.show(dialog, algo, {
      symbol: guessSymbolForAlgo(algo),
      interval: guessIntervalForAlgo(algo) as any,
      brokerKind: liveCfg.brokerage,
      equityUsd: liveEquity,
    })
    if (!params) return
    // Immediately start the run (returns fast with a "starting" state)
    // and open the live dialog so the user sees setup progress live.
    try {
      const run = await liveRuns.start({
        algorithm: algo,
        symbol: params.symbol,
        interval: params.interval,
        accountProviderID: params.accountProviderID,
        brokerKind: params.brokerKind,
      })
      DialogLiveRun.show(dialog, run.id)
      toast.show({
        message: `Live run starting: ${algo.name} · ${params.symbol}`,
        variant: "info",
        duration: 3000,
      })
    } catch (e: any) {
      if (e instanceof Plan.PlanLimitError) {
        const featureLabel =
          e.feature === "terminal_runs"
            ? "terminal live runs"
            : e.feature.startsWith("live_brokerage:")
              ? `live trading on ${e.feature.split(":")[1]}`
              : e.feature
        const message =
          e.required === "pro"
            ? `You've hit your Lite limit for ${featureLabel}. Upgrade to Finny Pro for unlimited.`
            : `${featureLabel} requires Finny Lite or Pro.`
        await DialogProUpsell.show(dialog, message, e.required)
        return
      }
      const msg = e?.message ?? "Failed to start live run"
      await DialogAlert.show(dialog, "Live Run Failed", msg)
    }
  }

  const requestCloudRun = async () => {
    const currentTier = await Plan.getTier()
    setTier(currentTier)
    if (!Plan.hasAtLeast(currentTier, "lite")) {
      await DialogProUpsell.show(
        dialog,
        "Cloud live runs are included with Finny Lite and Pro.",
        "lite",
      )
      return
    }
    await DialogManagedHosting.show(dialog)
  }

  const runBacktest = async (algo: Algorithm.Info) => {
    const tier = await Plan.getTier()
    const cap = Plan.DAILY_BACKTEST_LIMIT[tier]
    if (Number.isFinite(cap)) {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const todayCount = history.list().filter((e) => e.timestamp >= todayStart.getTime()).length
      if (todayCount >= cap) {
        const required: Plan.Tier = tier === "free" ? "lite" : "pro"
        const message =
          tier === "free"
            ? "Free plan allows 10 backtests per day. Upgrade to Lite for 20/day, or Pro for unlimited."
            : "Lite plan allows 20 backtests per day. Upgrade to Pro for unlimited."
        await DialogProUpsell.show(dialog, message, required)
        return
      }
    }
    const cfg = parseConfig(algo.config)
    const equity = cfg.equity_usd ?? cfg.risk?.starting_equity_usd
    const params = await DialogBacktestParams.show(dialog, algo.name, {
      duration: cfg.backtest?.duration,
      interval: cfg.interval,
      capital: equity !== undefined ? String(equity) : undefined,
    })
    if (!params) {
      dialog.clear()
      return
    }
    DialogBacktestRunning.show(dialog, algo.name)
    try {
      const result = await BacktestRunner.run({
        algorithm: algo,
        duration: params.duration,
        interval: params.interval,
        capital: params.capital,
      })
      if (result.ok) {
        history.add({
          algorithmId: algo.algorithmId,
          algorithmName: algo.name,
          params,
          results: result.results,
        })
        DialogBacktestResults.show(dialog, algo.name, params, result.results)
      } else {
        await DialogAlert.show(dialog, "Backtest Failed", result.error)
      }
    } catch (e: any) {
      await DialogAlert.show(dialog, "Backtest Failed", e?.message ?? "Unexpected error")
      toast.show({ message: "Backtest failed", variant: "error", duration: 3000 })
    }
  }

  const deleteAlgo = async (algo: Algorithm.Info) => {
    const confirmed = await DialogAlert.confirm(dialog, "Delete Algorithm", `Delete "${algo.name}"? This cannot be undone.`)
    if (!confirmed) return
    try {
      await Algorithm.remove(algo.algorithmId)
      toast.show({ message: `Deleted "${algo.name}"`, variant: "info", duration: 3000 })
      setSelectedId(undefined)
      algos.refetch()
    } catch (e: any) {
      toast.show({ message: `Failed to delete: ${e?.message ?? "unknown"}`, variant: "error", duration: 5000 })
    }
  }

  const list = createMemo<Algorithm.Info[]>(() => algos.data() ?? [])
  const selected = createMemo<Algorithm.Info | undefined>(() => {
    const items = list()
    if (items.length === 0) return undefined
    const id = selectedId()
    return items.find((a) => a.algorithmId === id) ?? items[0]
  })

  return (
    <box flexGrow={1} flexDirection="column">
      <RouteHeader
        icon={ROUTE_ICONS.algorithms as unknown as string[]}
        title="Algorithms"
        subtitle="AI-generated trading strategies"
        meta={`${list().length} total`}
      />

      <box
        flexGrow={1}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={2}
        paddingBottom={2}
        flexDirection="row"
        gap={2}
        minHeight={0}
      >
        <box width={34} minHeight={0} flexShrink={0}>
          <Card title=" Your library ">
            <Show
              when={list().length > 0}
              fallback={
                <text fg={theme.textMuted}>
                  No algorithms yet. Use /build to create one.
                </text>
              }
            >
              <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
                <box flexDirection="column" gap={1}>
                  <For each={list()}>
                    {(algo) => {
                      const isActive = () => selected()?.algorithmId === algo.algorithmId
                      return (
                        <box
                          flexDirection="row"
                          paddingLeft={1}
                          paddingRight={1}
                          onMouseUp={() => setSelectedId(algo.algorithmId)}
                        >
                          <text fg={isActive() ? theme.primary : theme.textMuted}>
                            {isActive() ? "▎ " : "  "}
                          </text>
                          <box flexDirection="column" flexGrow={1}>
                            <text fg={theme.text} attributes={isActive() ? 1 : 0}>
                              {algo.name}
                            </text>
                            <text fg={theme.textMuted}>
                              v{algo.version} · {algo.status}
                            </text>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </scrollbox>
            </Show>
          </Card>
        </box>

        <box flexGrow={1} minHeight={0}>
          <Card title=" Source ">
            <Show
              when={selected()}
              fallback={
                <text fg={theme.textMuted}>
                  Select an algorithm to view its source.
                </text>
              }
            >
              {(algo) => (
                <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
                  <box flexDirection="row" flexShrink={0} gap={1}>
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      onMouseUp={() => deleteAlgo(algo())}
                    >
                      <text fg={theme.error}>Delete</text>
                    </box>
                    <box flexGrow={1} />
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      backgroundColor={theme.backgroundElement}
                      onMouseUp={() => runBacktest(algo())}
                    >
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        ▶ Run Backtest
                      </text>
                    </box>
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      backgroundColor={theme.primary}
                      onMouseUp={() => runLive(algo())}
                    >
                      <text fg={theme.background} attributes={TextAttributes.BOLD}>
                        ◉ Run Live
                      </text>
                    </box>
                    <Show when={Plan.hasAtLeast(tier(), "lite")}>
                      <box
                        paddingLeft={2}
                        paddingRight={2}
                        backgroundColor={theme.backgroundElement}
                        onMouseUp={requestCloudRun}
                      >
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                          ☁ Request Cloud
                        </text>
                      </box>
                    </Show>
                  </box>
                  <AlgorithmCodeView algorithm={algo()} />
                </box>
              )}
            </Show>
          </Card>
        </box>
      </box>
    </box>
  )
}
