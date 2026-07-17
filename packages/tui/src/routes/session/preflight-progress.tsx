import { createEffect, createMemo, createSignal, For, Show, type Setter } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { BorderSides } from "@opentui/core"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { Spinner } from "../../component/spinner"
import type { PreflightStep } from "./preflight-steps"

export type { PreflightStep } from "./preflight-steps"
export { appendPreflightStep, preflightStepsFromStatus, toPreflightSteps } from "./preflight-steps"

export function usePreflightSteps(sessionID: string | undefined, onUpdate?: () => void) {
  const sync = useSync()
  const steps = createMemo(() => sync.data.preflight_steps?.[sessionID ?? ""] ?? [])
  const active = createMemo(() => sync.data.session_status?.[sessionID ?? ""]?.type === "preflight")

  createEffect(() => {
    steps()
    active()
    onUpdate?.()
  })

  return { steps, active }
}

function ProgressHeader(props: {
  expanded: boolean
  completed: boolean
  summary: string
  onToggle: (event?: { stopPropagation?: () => void }) => void
}) {
  const { theme } = useTheme()
  return (
    <box onMouseUp={props.onToggle} flexShrink={0}>
      <text fg={theme.info}>
        {props.expanded ? "▾ " : "▸ "}
        Workspace setup
        <Show when={!props.expanded}>
          <span style={{ fg: theme.textMuted }}>
            {" "}
            · {props.completed ? "✓ " : ""}
            {props.summary}
          </span>
        </Show>
      </text>
    </box>
  )
}

function ProgressStepRow(props: { step: PreflightStep }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <Show
        when={props.step.status === "active"}
        fallback={
          <text flexShrink={0} fg={theme.success}>
            ✓
          </text>
        }
      >
        <Spinner color={theme.info} />
      </Show>
      <text fg={props.step.status === "active" ? theme.text : theme.textMuted}>{props.step.message}</text>
    </box>
  )
}

function ProgressStepList(props: { steps: PreflightStep[] }) {
  const { theme } = useTheme()
  return (
    <Show
      when={props.steps.length > 0}
      fallback={
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Spinner color={theme.info} />
          <text fg={theme.text}>Preparing workspace…</text>
        </box>
      }
    >
      <box gap={1}>
        <For each={props.steps}>{(step) => <ProgressStepRow step={step} />}</For>
      </box>
    </Show>
  )
}

function frameStyle(attached: boolean, expanded: boolean): {
  paddingBottom: number
  paddingLeft: number
  backgroundColor: boolean | undefined
  border: BorderSides[] | undefined
  customBorderChars: typeof SplitBorder.customBorderChars | undefined
} {
  if (attached) {
    return {
      paddingBottom: 0,
      paddingLeft: 0,
      backgroundColor: undefined,
      border: ["top"],
      customBorderChars: SplitBorder.customBorderChars,
    }
  }
  return {
    paddingBottom: expanded ? 1 : 0,
    paddingLeft: 2,
    backgroundColor: true,
    border: undefined,
    customBorderChars: undefined,
  }
}

function ProgressFrame(props: { attached?: boolean; expanded: boolean; children: any }) {
  const { theme } = useTheme()
  const style = frameStyle(props.attached === true, props.expanded)
  return (
    <box
      gap={1}
      paddingTop={1}
      paddingBottom={style.paddingBottom}
      paddingLeft={style.paddingLeft}
      backgroundColor={style.backgroundColor ? theme.backgroundElement : undefined}
      border={style.border}
      borderColor={style.border ? theme.borderSubtle : undefined}
      customBorderChars={style.customBorderChars}
      onMouseUp={(event) => event.stopPropagation?.()}
      onMouseDown={(event) => event.stopPropagation?.()}
    >
      {props.children}
    </box>
  )
}

function shouldExpand(active: boolean | undefined, userToggled: boolean, completed: boolean): boolean | undefined {
  if (active) return true
  if (!userToggled && completed) return false
  return undefined
}

function canTogglePanel(props: { steps: PreflightStep[]; active?: boolean }, completed: boolean): boolean {
  return completed || Boolean(props.active) || props.steps.length > 0
}

function createPanelToggle(ctx: {
  renderer: ReturnType<typeof useRenderer>
  props: { steps: PreflightStep[]; active?: boolean }
  completed: () => boolean
  setUserToggled: Setter<boolean>
  setExpanded: Setter<boolean>
}) {
  return (event?: { stopPropagation?: () => void }) => {
    event?.stopPropagation?.()
    const selected = Boolean(ctx.renderer.getSelection()?.getSelectedText())
    if (selected || !canTogglePanel(ctx.props, ctx.completed())) return
    ctx.setUserToggled(true)
    ctx.setExpanded((value) => !value)
  }
}

function useProgressPanelState(props: { steps: PreflightStep[]; active?: boolean }) {
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(true)
  const [userToggled, setUserToggled] = createSignal(false)
  const completed = createMemo(
    () => !props.active && props.steps.length > 0 && props.steps.every((step) => step.status === "done"),
  )
  const summary = createMemo(() => props.steps.at(-1)?.message ?? "Preparing…")

  createEffect(() => {
    const next = shouldExpand(props.active, userToggled(), completed())
    if (next !== undefined) setExpanded(next)
    if (props.active) setUserToggled(false)
  })

  const toggle = createPanelToggle({ renderer, props, completed, setUserToggled, setExpanded })

  return { completed, expanded, summary, toggle }
}

function ProgressContent(props: {
  attached?: boolean
  expanded: boolean
  completed: boolean
  summary: string
  steps: PreflightStep[]
  onToggle: (event?: { stopPropagation?: () => void }) => void
}) {
  return (
    <ProgressFrame attached={props.attached} expanded={props.expanded}>
      <ProgressHeader
        expanded={props.expanded}
        completed={props.completed}
        summary={props.summary}
        onToggle={props.onToggle}
      />
      <Show when={props.expanded}>
        <ProgressStepList steps={props.steps} />
      </Show>
    </ProgressFrame>
  )
}

function DetachedProgressFrame(props: { children: any }) {
  const { theme } = useTheme()
  return (
    <box
      border={["left"]}
      borderColor={theme.info}
      customBorderChars={SplitBorder.customBorderChars}
      marginTop={1}
      flexShrink={0}
    >
      {props.children}
    </box>
  )
}

export function PreflightProgressPanel(props: {
  steps: PreflightStep[]
  active?: boolean
  attached?: boolean
}) {
  const panel = useProgressPanelState(props)
  const content = (
    <ProgressContent
      attached={props.attached}
      expanded={panel.expanded()}
      completed={panel.completed()}
      summary={panel.summary()}
      steps={props.steps}
      onToggle={panel.toggle}
    />
  )

  return (
    <Show when={props.steps.length > 0 || props.active}>
      <Show when={props.attached} fallback={<DetachedProgressFrame>{content}</DetachedProgressFrame>}>
        {content}
      </Show>
    </Show>
  )
}
