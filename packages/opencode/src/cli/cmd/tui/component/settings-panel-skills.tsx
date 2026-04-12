import { createResource, createSignal, For, Show } from "solid-js"
import { MouseEvent, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useProject } from "../context/project"
import { useToast } from "../ui/toast"
import { Card } from "./card"

interface SkillInfo {
  name: string
  description: string
  location: string
}

export function SettingsPanelSkills() {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const toast = useToast()

  const [busy, setBusy] = createSignal(false)
  const [newPath, setNewPath] = createSignal("")
  const [newUrl, setNewUrl] = createSignal("")

  const [skills, { refetch: refetchSkills }] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return (result.data ?? []) as SkillInfo[]
  })

  const configSkills = () => {
    const cfg = sync.data.config
    return {
      paths: (cfg as any)?.skills?.paths ?? ([] as string[]),
      urls: (cfg as any)?.skills?.urls ?? ([] as string[]),
    }
  }

  const updateSkillsConfig = async (paths: string[], urls: string[]) => {
    const workspace = project.workspace.current()
    const currentConfig = { ...sync.data.config }
    ;(currentConfig as any).skills = { paths, urls }
    await (sdk.client.config as any).update({ workspace, ...currentConfig })
  }

  const addPath = async () => {
    const p = newPath().trim()
    if (!p) return
    setBusy(true)
    try {
      const current = configSkills()
      await updateSkillsConfig([...current.paths, p], current.urls)
      setNewPath("")
      toast.show({ message: `Added skill path: ${p}`, variant: "info", duration: 3000 })
      refetchSkills()
    } catch (e: any) {
      toast.show({ message: `Failed: ${e?.message ?? "unknown"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const removePath = async (pathToRemove: string) => {
    setBusy(true)
    try {
      const current = configSkills()
      await updateSkillsConfig(
        current.paths.filter((p: string) => p !== pathToRemove),
        current.urls,
      )
      toast.show({ message: `Removed: ${pathToRemove}`, variant: "info", duration: 3000 })
      refetchSkills()
    } catch (e: any) {
      toast.show({ message: `Failed: ${e?.message ?? "unknown"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const addUrl = async () => {
    const u = newUrl().trim()
    if (!u) return
    setBusy(true)
    try {
      const current = configSkills()
      await updateSkillsConfig(current.paths, [...current.urls, u])
      setNewUrl("")
      toast.show({ message: `Added skill URL: ${u}`, variant: "info", duration: 3000 })
      refetchSkills()
    } catch (e: any) {
      toast.show({ message: `Failed: ${e?.message ?? "unknown"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const removeUrl = async (urlToRemove: string) => {
    setBusy(true)
    try {
      const current = configSkills()
      await updateSkillsConfig(
        current.paths,
        current.urls.filter((u: string) => u !== urlToRemove),
      )
      toast.show({ message: `Removed: ${urlToRemove}`, variant: "info", duration: 3000 })
      refetchSkills()
    } catch (e: any) {
      toast.show({ message: `Failed: ${e?.message ?? "unknown"}`, variant: "error", duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const InputBox = (props: { onInput: (v: string) => void }) => (
    <box
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      flexShrink={0}
    >
      <input
        onInput={(v: string) => props.onInput(v)}
        onMouseDown={(r: MouseEvent) => r.target?.focus()}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        focusedTextColor={theme.text}
      />
    </box>
  )

  return (
    <box flexGrow={1} flexDirection="row" gap={2} minHeight={0}>
      {/* Left: installed skills */}
      <box width={40} flexShrink={0} minHeight={0}>
        <Card title=" Installed skills ">
          <Show
            when={(skills() ?? []).length > 0}
            fallback={
              <box flexDirection="column" gap={1}>
                <text fg={theme.textMuted}>No skills found.</text>
                <text fg={theme.textMuted}>Add a skill folder path or URL to get started.</text>
              </box>
            }
          >
            <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
              <box flexDirection="column" gap={1}>
                <For each={skills() ?? []}>
                  {(skill) => (
                    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        /{skill.name}
                      </text>
                      <text fg={theme.textMuted}>{skill.description || "No description"}</text>
                      <text fg={theme.textMuted}>{skill.location}</text>
                    </box>
                  )}
                </For>
              </box>
            </scrollbox>
          </Show>
        </Card>
      </box>

      {/* Right: manage sources */}
      <box flexGrow={1} minHeight={0}>
        <Card title=" Manage skill sources ">
          <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
            <box flexDirection="column" gap={1}>
              <text fg={theme.textMuted}>
                Skills are SKILL.md files in folders. Add paths to local folders or URLs to remote indexes.
              </text>

              {/* Current paths */}
              <box paddingTop={1}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>Skill paths</text>
              </box>
              <Show
                when={configSkills().paths.length > 0}
                fallback={<text fg={theme.textMuted}>No custom paths configured.</text>}
              >
                <box flexDirection="column" gap={0}>
                  <For each={configSkills().paths}>
                    {(p) => (
                      <box flexDirection="row" gap={2} paddingLeft={1}>
                        <box flexGrow={1}>
                          <text fg={theme.text}>{p}</text>
                        </box>
                        <text fg={theme.error} onMouseUp={() => removePath(p)}>
                          ✕
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>

              <box paddingTop={1}>
                <text fg={theme.textMuted}>Add folder path</text>
              </box>
              <box flexDirection="row" gap={1}>
                <box flexGrow={1}>
                  <InputBox onInput={setNewPath} />
                </box>
                <box
                  paddingLeft={2}
                  paddingRight={2}
                  backgroundColor={busy() ? theme.borderSubtle : theme.primary}
                  onMouseUp={addPath}
                >
                  <text fg={theme.background} attributes={TextAttributes.BOLD}>Add</text>
                </box>
              </box>

              {/* Current URLs */}
              <box paddingTop={2}>
                <text fg={theme.text} attributes={TextAttributes.BOLD}>Skill URLs</text>
              </box>
              <Show
                when={configSkills().urls.length > 0}
                fallback={<text fg={theme.textMuted}>No remote skill URLs configured.</text>}
              >
                <box flexDirection="column" gap={0}>
                  <For each={configSkills().urls}>
                    {(u) => (
                      <box flexDirection="row" gap={2} paddingLeft={1}>
                        <box flexGrow={1}>
                          <text fg={theme.primary}>{u}</text>
                        </box>
                        <text fg={theme.error} onMouseUp={() => removeUrl(u)}>
                          ✕
                        </text>
                      </box>
                    )}
                  </For>
                </box>
              </Show>

              <box paddingTop={1}>
                <text fg={theme.textMuted}>Add remote URL</text>
              </box>
              <box flexDirection="row" gap={1}>
                <box flexGrow={1}>
                  <InputBox onInput={setNewUrl} />
                </box>
                <box
                  paddingLeft={2}
                  paddingRight={2}
                  backgroundColor={busy() ? theme.borderSubtle : theme.primary}
                  onMouseUp={addUrl}
                >
                  <text fg={theme.background} attributes={TextAttributes.BOLD}>Add</text>
                </box>
              </box>

              {/* Help */}
              <box
                paddingTop={2}
                paddingLeft={1}
                paddingRight={1}
                paddingBottom={1}
                border={["left"]}
                borderColor={theme.borderActive}
                flexDirection="column"
                gap={0}
              >
                <text fg={theme.text} attributes={TextAttributes.BOLD}>How skills work</text>
                <text fg={theme.textMuted}>
                  Skills are markdown files (SKILL.md) with YAML frontmatter defining reusable workflows.
                </text>
                <text fg={theme.textMuted}>
                  Invoke them with /skill-name in the prompt. Built-in skills load from ~/.claude/skills/ and .claude/skills/.
                </text>
                <text fg={theme.textMuted}>
                  Add custom folders here to load your own or team-shared skills.
                </text>
              </box>
            </box>
          </scrollbox>
        </Card>
      </box>
    </box>
  )
}
