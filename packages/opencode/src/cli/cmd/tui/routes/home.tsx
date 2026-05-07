import { Prompt, type PromptRef } from "@tui/component/prompt"
import { createEffect, createSignal, onMount, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Logo } from "../component/logo"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRoute, useRouteData } from "@tui/context/route"
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
  const routeCtx = useRoute()
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const kv = useKV()
  let sent = false

  const dimensions = useTerminalDimensions()

  // First-run flag: show Getting Started only on the very first Home visit.
  // Also gate on terminal height — on short windows the card crowded out the
  // logo / prompt / dashboard cards. Users on short windows can still reach
  // the same content via /help or /examples.
  const [seenGettingStarted, setSeenGettingStarted] = createSignal(!!kv.get(FIRST_RUN_KEY, false))
  const showGettingStarted = () => !seenGettingStarted() && dimensions().height >= 30
  const setShowGettingStarted = (v: boolean) => setSeenGettingStarted(!v)

  onMount(() => {
    if (showGettingStarted()) {
      kv.set(FIRST_RUN_KEY, true)
    }
  })

  const dismissGettingStarted = () => setShowGettingStarted(false)

  // Track the last initialPrompt we applied so the effect below doesn't
  // re-apply on every reactive tick. Initialized empty so the very first
  // navigation always triggers an apply.
  let lastAppliedInitialPrompt: string | undefined

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    // Bind only handles the one-shot CLI `--prompt` flag now. Route's
    // `initialPrompt` is handled by the effect below — that's the only
    // way to also catch SUBSEQUENT navigations (e.g. /examples → click
    // template, when home is already mounted and bind never re-fires).
    once = true
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
  }

  // Apply route.initialPrompt whenever it changes — works on first mount
  // AND on every subsequent navigation. After applying we CLEAR the field
  // from the route store so it's strictly a one-shot signal: navigating
  // back to home (or off to session) won't re-fill the input with stale
  // template text. If autoSubmit is set (e.g. Portfolio Builder), defer
  // the clear until sync + model are ready so we can submit it.
  createEffect(() => {
    const r = ref()
    if (!r) return
    const ip = route.initialPrompt
    if (!ip) return
    const key = ip.input + "|" + (ip.parts?.length ?? 0)
    if (key !== lastAppliedInitialPrompt) {
      lastAppliedInitialPrompt = key
      r.set(ip)
    }
    if (route.autoSubmit) {
      if (sent) return
      if (!sync.ready || !local.model.ready) return
      if (r.current.input !== ip.input) return
      sent = true
      r.submit()
      // Prompt.submit() already clears the input and (when on home)
      // schedules a navigate-to-session ~50ms later, which unmounts this
      // component. A follow-up reset() on the captured ref would race
      // that unmount and touch a destroyed input — drop it entirely.
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
