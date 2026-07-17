import { TextAttributes } from "@opentui/core"
import { createResource, For, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { useTheme } from "../context/theme"

/**
 * Read-only viewer for an algorithm's companion documents (mission.md and the
 * other folder artifacts). Sits to the right of the strategy code so the user
 * can see the intent, design log, and agent memory alongside the source.
 *
 * Files live at the root of the algorithm folder, except `reasoning.md`, which
 * lives inside the active version directory named by the `CURRENT` file.
 */

type DocFile = { label: string; body: string }

const ROOT_DOCS: Array<{ file: string; label: string }> = [
  { file: "mission.md", label: "mission.md" },
  { file: "prefs.md", label: "prefs.md" },
  { file: "decisions.md", label: "decisions.md" },
  { file: "memory.md", label: "memory.md" },
  { file: "review.md", label: "review.md" },
]

async function readOptional(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8")
    const trimmed = text.trim()
    return trimmed.length > 0 ? text : undefined
  } catch {
    return undefined
  }
}

async function loadDocs(folderPath: string): Promise<DocFile[]> {
  const docs: DocFile[] = []

  for (const { file, label } of ROOT_DOCS) {
    const body = await readOptional(join(folderPath, file))
    if (body !== undefined) docs.push({ label, body })
  }

  // reasoning.md lives inside the active version folder named by CURRENT.
  const current = (await readOptional(join(folderPath, "CURRENT")))?.trim()
  if (current) {
    const body = await readOptional(join(folderPath, current, "reasoning.md"))
    if (body !== undefined) docs.push({ label: `${current}/reasoning.md`, body })
  }

  return docs
}

export function AlgorithmDocsView(props: { folderPath: string | undefined }) {
  const { theme } = useTheme()
  const [docs] = createResource(
    () => props.folderPath,
    (path) => loadDocs(path),
  )

  return (
    <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
      <box flexShrink={0}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          Documents
        </text>
      </box>

      <Show
        when={props.folderPath}
        fallback={
          <text fg={theme.textMuted}>No local folder found for this algorithm.</text>
        }
      >
        <Show
          when={!docs.loading}
          fallback={<text fg={theme.textMuted}>Loading documents…</text>}
        >
          <Show
            when={(docs() ?? []).length > 0}
            fallback={<text fg={theme.textMuted}>No documents saved alongside this algorithm yet.</text>}
          >
            <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
              <box flexDirection="column" gap={1}>
                <For each={docs()}>
                  {(doc) => (
                    <box flexDirection="column" gap={1}>
                      <box flexShrink={0}>
                        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
                          {doc.label}
                        </text>
                      </box>
                      <box backgroundColor={theme.backgroundElement} paddingLeft={1} paddingRight={1}>
                        <text fg={theme.text}>{doc.body}</text>
                      </box>
                    </box>
                  )}
                </For>
              </box>
            </scrollbox>
          </Show>
        </Show>
      </Show>
    </box>
  )
}
