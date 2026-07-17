import { describe, expect, test } from "bun:test"
import path from "node:path"
import { createSignal, Show } from "solid-js"
import { testRender } from "@opentui/solid"

const root = path.resolve(import.meta.dir, "../../..")

function SessionLayout(props: { child: boolean }) {
  return (
    <box width="100%" height="100%" flexDirection="column" minHeight={0}>
      <box flexGrow={1}>
        <box height={1} />
        <text>{props.child ? "Child session" : "Parent session"}</text>
      </box>
      <Show
        when={props.child}
        fallback={
          <box width="100%" flexShrink={0}>
            <box width="100%" paddingLeft={2}>
              <text>Prompt</text>
            </box>
          </box>
        }
      >
        <box flexShrink={0} paddingTop={1} paddingBottom={1} paddingLeft={2}>
          <text>Subagent · Parent · Prev · Next</text>
        </box>
      </Show>
    </box>
  )
}

describe("OpenTUI runtime", () => {
  test("uses one native-layout release without the legacy Yoga WASM dependency", async () => {
    const manifest = await Bun.file(path.join(root, "package.json")).json()
    const catalog = manifest.workspaces.catalog as Record<string, string>
    const versions = [catalog["@opentui/core"], catalog["@opentui/keymap"], catalog["@opentui/solid"]]

    expect(new Set(versions).size).toBe(1)
    expect(versions[0]).toBe("0.4.3")

    const lockfile = await Bun.file(path.join(root, "bun.lock")).text()
    const core = lockfile.match(/"@opentui\/core": \["@opentui\/core@([^"]+)", "", \{ "dependencies": \{([^}]*)\}/)

    expect(core?.[1]).toBe(versions[0])
    expect(core?.[2]).not.toContain('"yoga-layout"')

    const resolved = await Bun.file(path.join(root, "packages/tui/node_modules/@opentui/core/package.json")).json()
    expect(resolved.version).toBe(versions[0])
    expect(resolved.dependencies?.["yoga-layout"]).toBeUndefined()
  })

  test("survives repeated parent and subagent teardown while the terminal resizes", async () => {
    const [sessionID, setSessionID] = createSignal<"parent" | "child">("parent")
    const app = await testRender(
      () => (
        <Show when={sessionID()} keyed>
          {(id) => <SessionLayout child={id === "child"} />}
        </Show>
      ),
      { width: 200, height: 55 },
    )

    try {
      await app.renderOnce()
      for (let index = 0; index < 20; index++) {
        setSessionID(index % 2 === 0 ? "child" : "parent")
        app.resize(160 + (index % 4) * 10, 42 + (index % 3) * 4)
        await app.renderOnce()
      }
      expect(app.renderer.isDestroyed).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })
})
