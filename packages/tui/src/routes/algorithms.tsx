import os from "node:os"
import path from "node:path"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import open from "open"
import { BacktestRunner } from "@/backtest/runner"
import { Algorithm } from "@/algorithm"
import { exportAlgorithmBundle, importAlgorithmBundle } from "@/algorithm/import-export"
import { parseConfig } from "@/algorithm/strategy-params"
import { liveTradingEnabled } from "@/live/brokers/live-trading"
import { useTheme } from "../context/theme"
import { useRouteData } from "../context/route"
import { useAlgorithms } from "../context/algorithms"
import { useBacktestHistory } from "../context/backtest-history"
import { useLiveRuns } from "../context/live-runs"
import { useSDK } from "../context/sdk"
import { useTuiTerminalEnvironment } from "../context/runtime"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
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
import { DialogAlgorithmVersions } from "../component/dialog-algorithm-versions"
import { resolveAlgorithmFolder } from "../util/algorithm-folder"
import { errorMessage } from "../util/error"
import {
  chooseZipFileWithFileManager,
  chooseZipSavePathWithFileManager,
  fileManagerName,
  supportsNativeZipPicker,
} from "../util/file-manager"

type RunMode = "paper" | "live"

export function Algorithms() {
  const { theme } = useTheme()
  const algos = useAlgorithms()
  const history = useBacktestHistory()
  const liveRuns = useLiveRuns()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const terminal = useTuiTerminalEnvironment()
  const routeData = useRouteData("algorithms")
  const [selectedId, setSelectedId] = createSignal<string | undefined>(routeData.algorithmId)
  const showLiveRun = liveTradingEnabled()

  // Always refetch on route mount so newly-built algos show up.
  onMount(async () => {
    algos.refetch()
  })

  // If the route is updated with a new algorithmId (e.g. clicked from Home's
  // Recent algorithms card), honor it.
  createEffect(() => {
    if (routeData.algorithmId) setSelectedId(routeData.algorithmId)
  })

  const guessSymbolForAlgo = (algo: Algorithm.Info): string => {
    const params = parseConfig(algo.config)
    if (params.symbol) return params.symbol
    const code = algo.code || ""
    const m1 = code.match(/SYMBOL\s*=\s*["']([^"']+)["']/)
    if (m1) return m1[1]
    const stop = new Set([
      "INTRADAY",
      "HYBRID",
      "MOMENTUM",
      "MEAN",
      "REVERSION",
      "BREAKOUT",
      "STRATEGY",
      "ALGO",
      "V1",
      "V2",
      "V3",
      "V4",
      "V5",
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

  const strictRunId = (algo: Algorithm.Info) =>
    history
      .list()
      .find(
        (entry) =>
          entry.algorithmId === algo.algorithmId &&
          typeof entry.results.runId === "string" &&
          entry.results.runId.length > 0,
      )?.results.runId

  const startRun = async (algo: Algorithm.Info, runMode: RunMode) => {
    // Local terminal run. The runner still enforces validation,
    // eligibility, credential, and duplicate-run checks.
    const liveCfg = parseConfig(algo.config)
    const liveEquity = liveCfg.equity_usd ?? liveCfg.risk?.starting_equity_usd
    const runId = strictRunId(algo)
    if (!runId) {
      await DialogAlert.show(
        dialog,
        "Live Run Failed",
        "No exact strict backtest run is available. Run and approve finny_backtest before starting paper or live trading.",
      )
      return
    }
    const params = await DialogLiveConfirm.show(dialog, algo, {
      runMode,
      runId,
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
        runId,
        symbol: params.symbol,
        interval: params.interval,
        accountProviderID: params.accountProviderID,
        brokerKind: params.brokerKind,
        executionMode: runMode,
        ...(params.challengeId ? { challengeId: params.challengeId, realMoneyAcknowledgement: true } : {}),
      })
      DialogLiveRun.show(dialog, run.id)
      const label =
        params.brokerKind === "robinhood" ? "Robinhood live run" : runMode === "live" ? "Live run" : "Paper trading"
      toast.show({
        message: `${label} starting: ${algo.name} · ${params.symbol}`,
        variant: "info",
        duration: 3000,
      })
    } catch (e: any) {
      const msg = e?.message ?? "Failed to start live run"
      await DialogAlert.show(dialog, "Live Run Failed", msg)
    }
  }

  const openAlgorithmFolder = async (algo: Algorithm.Info) => {
    try {
      const home = await sdk.client.config.finnyHome.get({}, { throwOnError: true })
      const artifacts = home.data!.artifacts
      const resolved = await resolveAlgorithmFolder({
        algorithmId: algo.algorithmId,
        name: algo.name,
        algosRoot: artifacts.algos,
        algorithmsRoot: artifacts.algorithms,
      })
      if (!resolved.found) {
        toast.show({ message: `No local folder found for ${algo.name}`, variant: "warning", duration: 5000 })
        return
      }

      try {
        await open(resolved.path)
        toast.show({ message: `Opening folder: ${algo.name}`, variant: "info", duration: 3000 })
      } catch {
        toast.show({ message: `Open failed: ${resolved.path}`, variant: "error", duration: 7000 })
      }
    } catch (err) {
      toast.show({ message: errorMessage(err), variant: "error", duration: 5000 })
    }
  }

  const safeZipName = (value: string) => {
    const name = value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
    return name || "algorithm"
  }

  const defaultExportZipPath = (algo: Algorithm.Info): string => {
    return path.join(os.homedir(), "Downloads", `${safeZipName(algo.name)}-v${algo.version}.zip`)
  }

  const expandHomePath = (value: string): string => {
    if (value === "~") return os.homedir()
    if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
    return value
  }

  const ensureZipExtension = (value: string): string => {
    return path.extname(value).toLowerCase() === ".zip" ? value : `${value}.zip`
  }

  const promptForImportZipPath = async (): Promise<string | undefined> => {
    if (supportsNativeZipPicker({ platform: terminal.platform })) {
      dialog.clear()
      try {
        const selectedPath = await chooseZipFileWithFileManager({
          currentPath: path.join(os.homedir(), "Downloads"),
          platform: terminal.platform,
        })
        if (selectedPath) return selectedPath
        return undefined
      } catch {
        toast.show({
          message: `Could not open ${fileManagerName({ platform: terminal.platform })} picker; enter a zip path manually`,
          variant: "warning",
          duration: 5000,
        })
      }
    }

    const value = await DialogPrompt.show(dialog, "Import Algorithm Zip", {
      placeholder: "/absolute/path/algorithm.zip",
    })
    if (value === null) return undefined
    const trimmed = value.trim()
    return trimmed ? expandHomePath(trimmed) : undefined
  }

  const promptForExportZipPath = async (algo: Algorithm.Info): Promise<string | undefined> => {
    const defaultPath = defaultExportZipPath(algo)
    if (supportsNativeZipPicker({ platform: terminal.platform })) {
      dialog.clear()
      try {
        const selectedPath = await chooseZipSavePathWithFileManager({
          defaultPath,
          platform: terminal.platform,
        })
        if (selectedPath) return ensureZipExtension(selectedPath)
        return undefined
      } catch {
        toast.show({
          message: `Could not open ${fileManagerName({ platform: terminal.platform })} picker; enter an export path manually`,
          variant: "warning",
          duration: 5000,
        })
      }
    }

    const value = await DialogPrompt.show(dialog, "Export Algorithm Zip", {
      value: defaultPath,
      placeholder: "/absolute/path/algorithm.zip",
    })
    if (value === null) return undefined
    const trimmed = value.trim()
    return trimmed ? ensureZipExtension(expandHomePath(trimmed)) : undefined
  }

  const exportSelectedAlgorithm = async () => {
    const algo = selected()
    if (!algo) {
      toast.show({ message: "Select an algorithm to export", variant: "warning", duration: 3000 })
      return
    }

    const zipPath = await promptForExportZipPath(algo)
    if (!zipPath) return

    try {
      const result = await exportAlgorithmBundle(algo, zipPath)
      toast.show({
        message: `Exported "${algo.name}" to ${result.zipPath}`,
        variant: "success",
        duration: 5000,
      })
    } catch (err) {
      toast.show({ message: errorMessage(err), variant: "error", duration: 7000 })
    }
  }

  const importAlgorithmZip = async () => {
    const zipPath = await promptForImportZipPath()
    if (!zipPath) return

    try {
      const imported = await importAlgorithmBundle(zipPath, { conflictPolicy: "copy" })
      algos.refetch()
      setSelectedId(imported.algorithm.algorithmId)
      toast.show({
        message: `Imported "${imported.algorithm.name}"`,
        variant: "success",
        duration: 5000,
      })
    } catch (err) {
      toast.show({ message: errorMessage(err), variant: "error", duration: 7000 })
    }
  }

  const openRunMode = async (algo: Algorithm.Info) => {
    const cfg = parseConfig(algo.config)
    const isQcAlgo = cfg.runtime?.profile?.profileId === "qc_cloud"
    const qcApi = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const base = liveRuns.url()
      if (!base) throw new Error("Live daemon is not connected")
      const res = await fetch(new URL(path, base), {
        ...init,
        headers: { "content-type": "application/json" },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`QC request failed (${res.status}): ${text}`)
      }
      return (await res.json()) as T
    }
    const linkQcProject = async () => {
      try {
        const projects = await qcApi<Array<{ projectId: number; name: string; language: string }>>("/qc/projects")
        if (projects.length === 0) {
          await DialogAlert.show(dialog, "QC Link", "No QuantConnect projects found. Connect QC credentials in Settings first.")
          return
        }
        const doLink = async (selected: number) => {
          dialog.clear()
          try {
            const state = await qcApi<{ linked: boolean; state?: string; drift?: string[] }>("/qc/link", {
              method: "POST",
              body: JSON.stringify({ algorithmId: algo.algorithmId, projectId: selected }),
            })
            toast.show({
              message: state.linked
                ? `Linked to QC project ${selected} (${state.state ?? "linked"}).`
                : `QC link failed: ${state.drift?.join("; ") ?? "unknown"}`,
              variant: state.linked ? "success" : "error",
              duration: 6000,
            })
          } catch (e: any) {
            await DialogAlert.show(dialog, "QC Link Failed", e?.message ?? "Unknown error")
          }
        }
        dialog.replace(() => (
          <DialogSelect
            title="Link QuantConnect project"
            skipFilter
            options={projects.map((project) => ({
              title: `${project.name} (${project.language})`,
              value: project.projectId,
              description: `Project ${project.projectId}`,
              onSelect: () => {
                void doLink(project.projectId)
              },
            }))}
          />
        ))
      } catch (e: any) {
        await DialogAlert.show(dialog, "QC Link Failed", e?.message ?? "Unknown error")
      }
    }
    const syncQcProject = async () => {
      try {
        const state = await qcApi<{ linked: boolean; state?: string; drift?: string[] }>(
          `/qc/link/${encodeURIComponent(algo.algorithmId)}`,
        )
        toast.show({
          message: state.linked
            ? `QC sync: ${state.state ?? "unknown"}${state.drift?.length ? ` — ${state.drift.join("; ")}` : ""}`
            : "Not linked to a QuantConnect project.",
          variant: state.state === "in_sync" ? "success" : state.linked ? "warning" : "error",
          duration: 6000,
        })
      } catch (e: any) {
        await DialogAlert.show(dialog, "QC Sync Failed", e?.message ?? "Unknown error")
      }
    }
    const runQcComposite = async () => {
      dialog.clear()
      try {
        const outcome = await qcApi<{
          ok: boolean
          error?: string
          compositeVerdict?: string
          backtestUrl?: string
          cloudGates?: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }
        }>("/qc/backtest", {
          method: "POST",
          body: JSON.stringify({ algorithmId: algo.algorithmId }),
        })
        if (!outcome.ok) {
          await DialogAlert.show(dialog, "QC Composite Failed", outcome.error ?? "Unknown error")
          return
        }
        const gates = (outcome.cloudGates?.checks ?? [])
          .map((check) => `[${check.passed ? "PASS" : "FAIL"}] ${check.name}: ${check.detail}`)
          .join("\n")
        await DialogAlert.show(
          dialog,
          "QC Composite",
          `Composite verdict: ${outcome.compositeVerdict}\n${gates}\n${outcome.backtestUrl ?? ""}`,
        )
      } catch (e: any) {
        await DialogAlert.show(dialog, "QC Composite Failed", e?.message ?? "Unknown error")
      }
    }
    dialog.replace(() => (
      <DialogSelect
        title={`Run ${algo.name}`}
        skipFilter
        options={[
          ...(isQcAlgo
            ? [
                {
                  title: "QuantConnect: Run Composite Backtest",
                  value: "qc-composite" as const,
                  description: "QC Cloud + Crucible dual-engine evaluation",
                  onSelect: () => {
                    void runQcComposite()
                  },
                },
                {
                  title: "QuantConnect: Link Project",
                  value: "qc-link" as const,
                  description: "Bind this algorithm to an existing QC project",
                  onSelect: () => {
                    void linkQcProject()
                  },
                },
                {
                  title: "QuantConnect: Sync Status",
                  value: "qc-sync" as const,
                  description: "Check source drift against the linked project",
                  onSelect: () => {
                    void syncQcProject()
                  },
                },
              ]
            : [
                {
                  title: "Paper Trading",
                  value: "paper" as const,
                  description: "Use a paper or testnet brokerage account",
                  onSelect: () => {
                    void startRun(algo, "paper")
                  },
                },
                ...(showLiveRun
                  ? [
                      {
                        title: "Trade Live",
                        value: "live" as const,
                        description: "Use a compatible live brokerage account",
                        onSelect: () => {
                          void startRun(algo, "live")
                        },
                      },
                    ]
                  : []),
              ]),
        ]}
      />
    ))
  }

  const runBacktest = async (algo: Algorithm.Info) => {
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
    const confirmed = await DialogAlert.confirm(
      dialog,
      "Delete Algorithm",
      `Delete "${algo.name}"? This cannot be undone.`,
    )
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
        right={
          <box flexDirection="row" gap={1}>
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={theme.backgroundElement}
              onMouseUp={() => {
                void importAlgorithmZip()
              }}
            >
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Import
              </text>
            </box>
            <box
              paddingLeft={2}
              paddingRight={2}
              backgroundColor={theme.backgroundElement}
              onMouseUp={() => {
                void exportSelectedAlgorithm()
              }}
            >
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                Export
              </text>
            </box>
          </box>
        }
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
              fallback={<text fg={theme.textMuted}>No algorithms yet. Use /build to create one.</text>}
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
                          onMouseUp={() => {
                            setSelectedId(algo.algorithmId)
                          }}
                        >
                          <text fg={isActive() ? theme.primary : theme.textMuted}>{isActive() ? "▎ " : "  "}</text>
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
              fallback={<text fg={theme.textMuted}>Select an algorithm to view its source.</text>}
            >
              {(algo) => (
                <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
                  <box flexDirection="row" flexShrink={0} gap={1}>
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      onMouseUp={() => {
                        void deleteAlgo(algo())
                      }}
                    >
                      <text fg={theme.error}>Delete</text>
                    </box>
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      onMouseUp={() => {
                        DialogAlgorithmVersions.show(dialog, algo())
                      }}
                    >
                      <text fg={theme.text}>Versions</text>
                    </box>
                    <box flexGrow={1} />
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      backgroundColor={theme.backgroundElement}
                      onMouseUp={() => {
                        void runBacktest(algo())
                      }}
                    >
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        Run Backtest
                      </text>
                    </box>
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      backgroundColor={theme.primary}
                      onMouseUp={() => void openRunMode(algo())}
                    >
                      <text fg={theme.background} attributes={TextAttributes.BOLD}>
                        Run
                      </text>
                    </box>
                    <box
                      paddingLeft={2}
                      paddingRight={2}
                      backgroundColor={theme.backgroundElement}
                      onMouseUp={() => {
                        void openAlgorithmFolder(algo())
                      }}
                    >
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        Open Folder
                      </text>
                    </box>
                  </box>
                  <box flexGrow={1} minHeight={0}>
                    <AlgorithmCodeView algorithm={algo()} />
                  </box>
                </box>
              )}
            </Show>
          </Card>
        </box>
      </box>
    </box>
  )
}
