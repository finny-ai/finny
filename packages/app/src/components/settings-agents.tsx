import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, createSignal, Show, type Component } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { decode64 } from "@/utils/base64"
import { SettingsList } from "./settings-list"

type DataAgentInstructions = {
  path: "data-agent/instructions.md"
  absolute_path: string
  content: string
  exists: boolean
}

export const SettingsAgents: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const params = useParams()

  const [content, setContent] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const directory = createMemo(() => decode64(params.dir))

  const request = async (method: "GET" | "PUT", body?: { content: string }) => {
    const current = server.current
    if (!current) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const url = new URL("/config/data-agent-instructions", current.http.url)
    const headers = new Headers({
      accept: "application/json",
    })
    const currentDirectory = directory()
    if (!currentDirectory) throw new Error(language.t("settings.agents.dataSources.error.noDirectory"))
    headers.set("x-opencode-directory", encodeURIComponent(currentDirectory))

    if (current.http.password) {
      headers.set("authorization", `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`)
    }

    if (body) headers.set("content-type", "application/json")

    const response = await (platform.fetch ?? fetch)(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || response.statusText)
    }

    return response.json() as Promise<DataAgentInstructions>
  }

  const [instructions, { refetch, mutate }] = createResource(directory, async () => request("GET"))

  createEffect(() => {
    const latest = instructions()
    if (!latest) return
    setContent(latest.content)
  })

  const dirty = createMemo(() => content() !== (instructions()?.content ?? ""))
  const pathLabel = createMemo(() => instructions()?.path ?? "data-agent/instructions.md")
  const absolutePath = createMemo(() => instructions()?.absolute_path ?? "")

  const reload = async () => {
    const next = await refetch()
    if (next) setContent(next.content)
  }

  const save = async () => {
    if (saving()) return
    setSaving(true)
    try {
      const next = await request("PUT", { content: content() })
      mutate(next)
      setContent(next.content)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.agents.dataSources.toast.saved.title"),
        description: language.t("settings.agents.dataSources.toast.saved.description"),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[840px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.agents.title")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[840px]">
        <div class="flex flex-col gap-1" data-component="settings-agents-data-sources">
          <div class="flex items-center justify-between gap-3 pb-2">
            <div class="min-w-0">
              <h3 class="text-14-medium text-text-strong">
                {language.t("settings.agents.dataSources.title")}
              </h3>
              <p class="text-12-regular text-text-weak mt-1">
                {language.t("settings.agents.dataSources.description")}
              </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <Button
                size="small"
                variant="ghost"
                icon="reset"
                disabled={instructions.loading || saving()}
                onClick={() => void reload()}
              >
                {language.t("settings.agents.dataSources.action.reload")}
              </Button>
              <Button
                size="small"
                variant="primary"
                icon="check"
                disabled={instructions.loading || saving() || !dirty()}
                onClick={() => void save()}
              >
                {saving() ? language.t("settings.agents.dataSources.action.saving") : language.t("common.save")}
              </Button>
            </div>
          </div>

          <SettingsList>
            <div class="flex flex-col gap-3 py-4">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-12-regular">
                <div class="flex items-center gap-2 text-text-base min-w-0">
                  <Icon name="file-tree" size="small" class="text-icon-weak-base shrink-0" />
                  <code class="truncate">{pathLabel()}</code>
                </div>
                <Show when={instructions()?.exists === false}>
                  <span class="text-text-weak">{language.t("settings.agents.dataSources.status.missing")}</span>
                </Show>
              </div>

              <Show when={absolutePath()}>
                <code class="block text-11-regular text-text-weak truncate">{absolutePath()}</code>
              </Show>

              <Show
                when={!instructions.error}
                fallback={
                  <div class="rounded-md border border-border-weak-base bg-surface-raised-base px-3 py-2 text-13-regular text-text-base">
                    {language.t("settings.agents.dataSources.status.loadFailed")}
                  </div>
                }
              >
                <textarea
                  aria-label={language.t("settings.agents.dataSources.editorLabel")}
                  spellcheck={false}
                  value={content()}
                  onInput={(event) => setContent(event.currentTarget.value)}
                  class="min-h-[420px] w-full resize-y rounded-md border border-border-weak-base bg-surface-raised-base p-3 font-mono text-12-regular text-text-strong outline-none focus:border-border-strong-base"
                />
              </Show>
            </div>
          </SettingsList>
        </div>
      </div>
    </div>
  )
}
