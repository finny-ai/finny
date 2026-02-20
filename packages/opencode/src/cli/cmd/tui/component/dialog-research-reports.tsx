import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, Show, For, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import fs from "fs"
import path from "path"
import { Instance } from "@/project/instance"

const RESEARCH_DIR = ".finny/research"

interface ReportInfo {
  filename: string
  filepath: string
  date: string
  symbol: string
  title: string
  size: number
}

type Step = "list" | "view"

export function DialogResearchReports() {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [step, setStep] = createSignal<Step>("list")
  const [reports, setReports] = createSignal<ReportInfo[]>([])
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [viewContent, setViewContent] = createSignal<string>("")
  const [viewReport, setViewReport] = createSignal<ReportInfo | null>(null)
  const [scrollOffset, setScrollOffset] = createSignal(0)

  async function loadReports() {
    setLoading(true)
    setError(null)

    const researchDir = path.join(Instance.directory, RESEARCH_DIR)

    try {
      const dirExists = await fs.promises
        .access(researchDir)
        .then(() => true)
        .catch(() => false)

      if (!dirExists) {
        setReports([])
        setLoading(false)
        return
      }

      const files = await fs.promises.readdir(researchDir)
      const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse()

      const reportInfos: ReportInfo[] = []

      for (const filename of mdFiles) {
        const filepath = path.join(researchDir, filename)
        const stats = await fs.promises.stat(filepath)

        // Parse filename: YYYY-MM-DD-HHMMSS-SYMBOL-title.md
        const parts = filename.replace(".md", "").split("-")
        const date = parts.slice(0, 3).join("-")
        let symbol = "Unknown"
        let title = filename

        if (parts.length > 4) {
          symbol = parts[4]
          title = parts
            .slice(5)
            .join(" ")
            .replace(/-/g, " ")
            .split(" ")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ")
        }

        reportInfos.push({
          filename,
          filepath,
          date,
          symbol,
          title: title || filename,
          size: stats.size,
        })
      }

      setReports(reportInfos)
    } catch (err: any) {
      setError(`Failed to load reports: ${err.message}`)
    }

    setLoading(false)
  }

  async function viewSelectedReport() {
    const report = reports()[selected()]
    if (!report) return

    try {
      const content = await fs.promises.readFile(report.filepath, "utf-8")
      setViewContent(content)
      setViewReport(report)
      setScrollOffset(0)
      setStep("view")
    } catch (err: any) {
      setError(`Failed to read report: ${err.message}`)
    }
  }

  async function deleteSelectedReport() {
    const report = reports()[selected()]
    if (!report) return

    try {
      await fs.promises.unlink(report.filepath)
      await loadReports()
      setSelected((s) => Math.max(0, Math.min(s, reports().length - 1)))
    } catch (err: any) {
      setError(`Failed to delete report: ${err.message}`)
    }
  }

  onMount(() => {
    loadReports()
  })

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      if (step() === "view") {
        setStep("list")
        setViewContent("")
        setViewReport(null)
      } else {
        dialog.clear()
      }
      return
    }

    if (step() === "list") {
      if (evt.name === "return" || evt.name === "enter") {
        viewSelectedReport()
      } else if (evt.name === "up" || evt.name === "k") {
        setSelected((s) => Math.max(0, s - 1))
      } else if (evt.name === "down" || evt.name === "j") {
        setSelected((s) => Math.min(reports().length - 1, s + 1))
      } else if (evt.name === "d") {
        deleteSelectedReport()
      } else if (evt.name === "r") {
        loadReports()
      }
    } else if (step() === "view") {
      // Scroll in view mode
      const lines = viewContent().split("\n")
      const maxScroll = Math.max(0, lines.length - 20)

      if (evt.name === "up" || evt.name === "k") {
        setScrollOffset((s) => Math.max(0, s - 1))
      } else if (evt.name === "down" || evt.name === "j") {
        setScrollOffset((s) => Math.min(maxScroll, s + 1))
      } else if (evt.name === "pageup") {
        setScrollOffset((s) => Math.max(0, s - 10))
      } else if (evt.name === "pagedown") {
        setScrollOffset((s) => Math.min(maxScroll, s + 10))
      }
    }
  })

  // Get visible content for scrolling
  const visibleContent = () => {
    const lines = viewContent().split("\n")
    const offset = scrollOffset()
    return lines.slice(offset, offset + 20).join("\n")
  }

  return (
    <>
      {/* List View */}
      <Show when={step() === "list"}>
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Research Reports
            </text>
            <text fg={theme.textMuted}>esc</text>
          </box>

          <Show when={error()}>
            <text fg={theme.error}>{error()}</text>
          </Show>

          <Show when={loading()}>
            <text fg={theme.textMuted}>Loading reports...</text>
          </Show>

          <Show when={!loading() && reports().length === 0 && !error()}>
            <text fg={theme.textMuted}>No research reports found.</text>
            <text fg={theme.textMuted}>Use the Research agent to create reports with save_research_report.</text>
          </Show>

          <Show when={!loading() && reports().length > 0}>
            <box>
              <For each={reports()}>
                {(report, i) => (
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={selected() === i() ? theme.backgroundElement : undefined}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <box flexDirection="row" gap={1}>
                      <text fg={selected() === i() ? theme.accent : theme.textMuted}>
                        {selected() === i() ? "\u25b6" : " "}
                      </text>
                      <text fg={theme.text}>
                        <span style={{ fg: theme.accent }}>{report.symbol}</span>: {report.title}
                      </text>
                    </box>
                    <text fg={theme.textMuted}>{report.date}</text>
                  </box>
                )}
              </For>
            </box>
          </Show>

          <text fg={theme.textMuted} marginTop={1}>
            <b>enter</b> view <b>d</b> delete <b>r</b> refresh <b>j/k</b> nav
          </text>
        </box>
      </Show>

      {/* View Report */}
      <Show when={step() === "view"}>
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {viewReport()?.symbol}: {viewReport()?.title}
            </text>
            <text fg={theme.textMuted}>esc back</text>
          </box>

          <box height={20} overflow="hidden">
            <text fg={theme.text}>
              {visibleContent()}
            </text>
          </box>

          <text fg={theme.textMuted} marginTop={1}>
            <b>j/k</b> scroll <b>pgup/pgdn</b> page <b>esc</b> back
          </text>
        </box>
      </Show>
    </>
  )
}
