import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, For, Show, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import fs from "fs"
import path from "path"

interface InsightFile {
  filename: string
  filepath: string
  date: string
  time: string
  category: string
  title: string
}

const CATEGORY_EMOJIS: Record<string, string> = {
  pattern: "🔧",
  "bug-fix": "🐛",
  optimization: "⚡",
  parameter: "🎛️",
  idea: "💡",
  lesson: "📖",
}

const CATEGORIES = ["all", "pattern", "bug-fix", "optimization", "parameter", "idea", "lesson"] as const

export function DialogBuildInsights() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const [insights, setInsights] = createSignal<InsightFile[]>([])
  const [filteredInsights, setFilteredInsights] = createSignal<InsightFile[]>([])
  const [selected, setSelected] = createSignal(0)
  const [categoryFilter, setCategoryFilter] = createSignal<string>("all")
  const [loading, setLoading] = createSignal(true)
  const [viewContent, setViewContent] = createSignal<string | null>(null)

  const insightsDir = path.join(sdk.directory ?? process.cwd(), ".finny/build-insights")

  async function loadInsights() {
    setLoading(true)
    try {
      const dirExists = await fs.promises
        .access(insightsDir)
        .then(() => true)
        .catch(() => false)

      if (!dirExists) {
        setInsights([])
        setFilteredInsights([])
        setLoading(false)
        return
      }

      const files = await fs.promises.readdir(insightsDir)
      const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse()

      const insightList: InsightFile[] = mdFiles.map((filename) => {
        const parts = filename.replace(".md", "").split("-")
        const date = parts.slice(0, 3).join("-")
        const time = parts[3] || ""
        const category = parts[4] || "unknown"
        const title = parts.slice(5).join(" ") || filename

        return {
          filename,
          filepath: path.join(insightsDir, filename),
          date,
          time,
          category,
          title,
        }
      })

      setInsights(insightList)
      applyFilter(insightList, categoryFilter())
    } catch (error) {
      toast.show({ variant: "error", message: `Failed to load insights: ${error}` })
      setInsights([])
      setFilteredInsights([])
    }
    setLoading(false)
  }

  function applyFilter(list: InsightFile[], category: string) {
    if (category === "all") {
      setFilteredInsights(list)
    } else {
      setFilteredInsights(list.filter((i) => i.category === category))
    }
    setSelected(0)
  }

  function cycleCategory(direction: number) {
    const currentIndex = CATEGORIES.indexOf(categoryFilter() as any)
    const newIndex = (currentIndex + direction + CATEGORIES.length) % CATEGORIES.length
    const newCategory = CATEGORIES[newIndex]
    setCategoryFilter(newCategory)
    applyFilter(insights(), newCategory)
  }

  async function viewInsight() {
    const insight = filteredInsights()[selected()]
    if (!insight) return

    try {
      const content = await fs.promises.readFile(insight.filepath, "utf-8")
      setViewContent(content)
    } catch (error) {
      toast.show({ variant: "error", message: `Failed to read insight: ${error}` })
    }
  }

  async function deleteInsight() {
    const insight = filteredInsights()[selected()]
    if (!insight) return

    try {
      await fs.promises.unlink(insight.filepath)
      toast.show({ variant: "info", message: `Deleted: ${insight.title}` })
      await loadInsights()
    } catch (error) {
      toast.show({ variant: "error", message: `Failed to delete: ${error}` })
    }
  }

  onMount(() => {
    loadInsights()
  })

  useKeyboard((evt) => {
    // If viewing content, any key closes the view
    if (viewContent() !== null) {
      if (evt.name === "escape" || evt.name === "return" || evt.name === "q") {
        setViewContent(null)
      }
      return
    }

    if (evt.name === "escape") {
      dialog.clear()
      return
    }

    if (evt.name === "return" || evt.name === "enter") {
      viewInsight()
      return
    }

    if (evt.name === "d" || evt.name === "delete") {
      deleteInsight()
      return
    }

    if (evt.name === "up" || evt.name === "k") {
      setSelected((s) => Math.max(0, s - 1))
    } else if (evt.name === "down" || evt.name === "j") {
      setSelected((s) => Math.min(filteredInsights().length - 1, s + 1))
    } else if (evt.name === "left" || evt.name === "h") {
      cycleCategory(-1)
    } else if (evt.name === "right" || evt.name === "l") {
      cycleCategory(1)
    } else if (evt.name === "r") {
      loadInsights()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <Show when={viewContent() !== null} fallback={
        <>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Build Insights
            </text>
            <text fg={theme.textMuted}>esc</text>
          </box>

          <box flexDirection="row" gap={2}>
            <text fg={theme.textMuted}>Category:</text>
            <For each={CATEGORIES}>
              {(cat) => (
                <text
                  fg={categoryFilter() === cat ? theme.accent : theme.textMuted}
                  attributes={categoryFilter() === cat ? TextAttributes.BOLD : undefined}
                >
                  {cat === "all" ? "all" : `${CATEGORY_EMOJIS[cat] || ""} ${cat}`}
                </text>
              )}
            </For>
          </box>

          <Show when={loading()}>
            <text fg={theme.textMuted}>Loading insights...</text>
          </Show>

          <Show when={!loading() && filteredInsights().length === 0}>
            <box marginTop={1}>
              <text fg={theme.textMuted}>
                No build insights found.
              </text>
              <text fg={theme.textMuted} marginTop={1}>
                Save insights during development using the save_build_insight tool.
              </text>
              <text fg={theme.textMuted} marginTop={1}>
                Categories: pattern, bug-fix, optimization, parameter, idea, lesson
              </text>
            </box>
          </Show>

          <Show when={!loading() && filteredInsights().length > 0}>
            <box marginTop={1} maxHeight={15}>
              <For each={filteredInsights()}>
                {(insight, i) => (
                  <box
                    flexDirection="column"
                    backgroundColor={selected() === i() ? theme.backgroundElement : undefined}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <box flexDirection="row" gap={1}>
                      <text fg={selected() === i() ? theme.accent : theme.textMuted}>
                        {selected() === i() ? "\u25b6" : " "}
                      </text>
                      <text fg={theme.textMuted}>[{insight.date}]</text>
                      <text fg={theme.text}>
                        {CATEGORY_EMOJIS[insight.category] || "📝"}
                      </text>
                      <text fg={theme.text} attributes={selected() === i() ? TextAttributes.BOLD : undefined}>
                        {insight.title}
                      </text>
                    </box>
                  </box>
                )}
              </For>
            </box>

            <text fg={theme.textMuted} marginTop={1}>
              Total: {filteredInsights().length} insight(s)
            </text>
          </Show>

          <text fg={theme.textMuted} marginTop={1}>
            <b>enter</b> view <b>d</b> delete <b>h/l</b> filter <b>j/k</b> navigate <b>r</b> refresh
          </text>
        </>
      }>
        <box flexDirection="column">
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Insight View
            </text>
            <text fg={theme.textMuted}>q/esc to close</text>
          </box>
          <box marginTop={1}>
            <scrollbox maxHeight={20}>
              <text fg={theme.text}>{viewContent()}</text>
            </scrollbox>
          </box>
        </box>
      </Show>
    </box>
  )
}
