import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createSignal, onMount, Show } from "solid-js"
import { Logo } from "../component/logo"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useKV } from "../context/kv"
import { TuiPluginRuntime } from "../plugin"
import { RecentAlgosCard } from "../component/card-recent-algos"
import { GettingStartedCard } from "../component/card-getting-started"
import { PortfolioCard } from "../component/card-portfolio"
import { ModelCapsule } from "../component/model-capsule"
import { ProviderCapsule } from "../component/provider-capsule"

const FIRST_RUN_KEY = "home_getting_started_seen"

let once = false
const placeholder = {
  normal: ["Describe a strategy...", "Build me a mean-reversion algo", "Research momentum strategies"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const sync = useSync()
  const project = useProject()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const kv = useKV()
  let sent = false

  // First-run flag: show Getting Started only on the very first Home visit.
  const [showGettingStarted, setShowGettingStarted] = createSignal(!kv.get(FIRST_RUN_KEY, false))

  onMount(() => {
    if (showGettingStarted()) {
      kv.set(FIRST_RUN_KEY, true)
    }
  })

  const dismissGettingStarted = () => setShowGettingStarted(false)

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.initialPrompt) {
      r.set(route.initialPrompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <box
        flexGrow={1}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={2}
        flexDirection="column"
      >
        {/* Getting Started floats top-right, smaller, first-run only */}
        <Show when={showGettingStarted()}>
          <box flexDirection="row" flexShrink={0}>
            <box flexGrow={1} />
            <box width={38} flexShrink={0}>
              <GettingStartedCard onDismiss={dismissGettingStarted} />
            </box>
          </box>
        </Show>

        {/* Top spacer — pushes the logo/prompt/cards group toward the middle */}
        <box flexGrow={1} minHeight={0} />

        {/* Logo (centered) */}
        <box flexShrink={0} alignItems="center">
          <TuiPluginRuntime.Slot name="home_logo" mode="replace">
            <Logo />
          </TuiPluginRuntime.Slot>
        </box>

        <box height={1} minHeight={0} flexShrink={0} />

        {/* Prompt */}
        <box width="100%" maxWidth={90} zIndex={1000} flexShrink={0} alignSelf="center">
          <TuiPluginRuntime.Slot
            name="home_prompt"
            mode="replace"
            workspace_id={project.workspace.current()}
            ref={bind}
          >
            <Prompt
              ref={bind}
              workspaceID={project.workspace.current()}
              right={<TuiPluginRuntime.Slot name="home_prompt_right" workspace_id={project.workspace.current()} />}
              placeholders={placeholder}
            />
          </TuiPluginRuntime.Slot>
        </box>

        {/* Model + Provider picker capsules (left-aligned, hug prompt) */}
        <box
          width="100%"
          maxWidth={90}
          alignSelf="center"
          flexShrink={0}
          flexDirection="row"
          gap={1}
          zIndex={1500}
          marginTop={-1}
        >
          <ModelCapsule />
          <ProviderCapsule />
        </box>

        <box height={1} minHeight={0} flexShrink={0} />

        {/* Dashboard cards: Recent Algos + Portfolio */}
        <box
          width="100%"
          maxWidth={110}
          alignSelf="center"
          flexDirection="row"
          gap={2}
          flexShrink={0}
          minHeight={0}
        >
          <box flexGrow={1} minWidth={0}>
            <RecentAlgosCard />
          </box>
          <box flexGrow={1} minWidth={0}>
            <PortfolioCard />
          </box>
        </box>

        <TuiPluginRuntime.Slot name="home_bottom" />
        {/* Bottom spacer — keeps group vertically centered but still bounded */}
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <TuiPluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </>
  )
}
