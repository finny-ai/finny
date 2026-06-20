import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onMount, Show } from "solid-js"
import { GettingStartedCard } from "../component/card-getting-started"
import { PortfolioCard } from "../component/card-portfolio"
import { RecentAlgosCard } from "../component/card-recent-algos"
import { FinnyLogo } from "../component/logo"
import { ModelCapsule } from "../component/model-capsule"
import { Prompt, type PromptRef } from "../component/prompt"
import { ProviderCapsule } from "../component/provider-capsule"
import { BrokerageCapsule } from "../component/brokerage-capsule"
import { StorageCapsule } from "../component/storage-capsule"
import { useArgs } from "../context/args"
import { useEditorContext } from "../context/editor"
import { useKV } from "../context/kv"
import { useLocal } from "../context/local"
import { usePromptRef } from "../context/prompt"
import { useRoute, useRouteData } from "../context/route"
import { useSync } from "../context/sync"
import { usePluginRuntime } from "../plugin/runtime"
import { Toast } from "../ui/toast"
import { HomeSessionDestinationProvider } from "./home/session-destination"

const FIRST_RUN_KEY = "home_getting_started_seen"

let once = false
const placeholder = {
  normal: ["Describe a strategy...", "Build me a mean-reversion algo", "Research momentum strategies"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const routeCtx = useRoute()
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const kv = useKV()
  const dimensions = useTerminalDimensions()
  let sent = false

  const [seenGettingStarted, setSeenGettingStarted] = createSignal(!!kv.get(FIRST_RUN_KEY, false))
  const showGettingStarted = () => !seenGettingStarted() && dimensions().height >= 30
  const setShowGettingStarted = (value: boolean) => setSeenGettingStarted(!value)
  const dismissGettingStarted = () => setShowGettingStarted(false)

  let lastAppliedInitialPrompt: string | undefined

  onMount(() => {
    editor.clearSelection()
    if (showGettingStarted()) kv.set(FIRST_RUN_KEY, true)
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  createEffect(() => {
    const r = ref()
    if (!r) return
    const initialPrompt = route.initialPrompt
    if (!initialPrompt) return

    const key = initialPrompt.input + "|" + (initialPrompt.parts?.length ?? 0)
    if (key !== lastAppliedInitialPrompt) {
      lastAppliedInitialPrompt = key
      r.set(initialPrompt)
    }

    if (route.autoSubmit) {
      if (sent) return
      if (!sync.ready || !local.model.ready) return
      if (r.current.input !== initialPrompt.input) return
      sent = true
      r.submit()
      routeCtx.clearInitialPrompt()
      return
    }

    routeCtx.clearInitialPrompt()
  })

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
    <HomeSessionDestinationProvider>
      <box flexGrow={1} paddingLeft={3} paddingRight={3} paddingTop={2} flexDirection="column">
        <Show when={showGettingStarted()}>
          <box flexDirection="row" flexShrink={0}>
            <box flexGrow={1} />
            <box width={38} flexShrink={0}>
              <GettingStartedCard onDismiss={dismissGettingStarted} />
            </box>
          </box>
        </Show>

        <box flexGrow={1} minHeight={0} />

        <box flexShrink={0} alignItems="center">
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <FinnyLogo />
          </pluginRuntime.Slot>
        </box>

        <box height={1} minHeight={0} flexShrink={0} />

        <box width="100%" maxWidth={90} zIndex={1000} flexShrink={0} alignSelf="center">
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt
              ref={bind}
              right={<pluginRuntime.Slot name="home_prompt_right" />}
              placeholders={placeholder}
              showShortcutHints={false}
            />
          </pluginRuntime.Slot>
        </box>

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
          <BrokerageCapsule />
          <StorageCapsule />
        </box>

        <box height={1} minHeight={0} flexShrink={0} />

        <box width="100%" maxWidth={110} alignSelf="center" flexDirection="row" gap={2} flexShrink={0} minHeight={0}>
          <box flexGrow={1} minWidth={0}>
            <RecentAlgosCard />
          </box>
          <box flexGrow={1} minWidth={0}>
            <PortfolioCard />
          </box>
        </box>

        <pluginRuntime.Slot name="home_tips" />
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}
