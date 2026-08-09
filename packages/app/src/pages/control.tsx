import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useServer } from "@/context/server"

export type AgentControlV1 = {
  id: string
  parentID?: string
  directory: string
  title: string
  agent?: string
  modelRef?: string
  status: "busy" | "idle" | "active" | "error" | "blocked"
  currentActivity?: string
  elapsedMs?: number
  cost?: number
  tokens?: number
  childCount: number
  taskCount: number
  pendingQuestionCount: number
  pendingPermissionCount: number
  timeCreated: number
  timeUpdated: number
}

export type TaskControlV1 = {
  id: string
  parentSessionID: string
  subagentType: string
  mode: string
  status: string
  startedAt?: number
  finishedAt?: number
  resultSummary?: string
  lastError?: string
  createdAt: number
  updatedAt: number
}

export type CrucibleWorkflowControlV1 = {
  workflowId: string
  sessionId: string
  workspaceSlug: string
  stage: string
  status: string
  phase: string
  revision: number
  requestVersion: number
  candidate?: unknown
  backtest?: unknown
  blocker?: unknown
  terminal?: unknown
  updatedAt: number
}

export type CrucibleEventControlV1 = {
  seq: number
  type: string
  occurredAt: number
  sourceKind: string
  summary?: string
  stage?: string
  message?: string
}

export type CampaignControlV1 = {
  id: string
  goal: string
  agent: string
  status: string
  rounds: number
  candidateCount: number
  eventsCount: number
  createdAt: number
  updatedAt: number
}

export type DomainHealthControlV1 = {
  domain: "agents" | "crucible" | "campaign"
  status: "fresh" | "stale" | "unavailable"
  message?: string
}

export type CommandReceiptV1 = {
  operationID: string
  accepted: boolean
  alreadyHandled?: boolean
  sessionID?: string
  workflowID?: string
  messageID?: string
  message?: string
}

export type ControlSnapshotV1 = {
  schema: "finny.control_snapshot"
  version: 1
  capturedAt: string
  agents: AgentControlV1[]
  tasks: TaskControlV1[]
  crucible: CrucibleWorkflowControlV1[]
  campaigns: CampaignControlV1[]
  health: DomainHealthControlV1[]
}

type ActionState = {
  kind: "steer" | "queue" | "abort"
  error?: string
  message?: string
}

type ControlState = {
  snapshot?: ControlSnapshotV1
  loading: boolean
  refreshing: boolean
  error?: string
  prompts: Record<string, string>
  actions: Record<string, ActionState | undefined>
  events: Record<string, CrucibleEventControlV1[] | undefined>
  eventErrors: Record<string, string | undefined>
  eventsLoading: Record<string, boolean | undefined>
}

type RefreshSource = "initial" | "manual" | "poll" | "event" | "visible" | "queued"

const POLL_INTERVAL_MS = 5_000
const SSE_RETRY_MS = 2_000
const SSE_MAX_ATTEMPTS = 5

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function formatDuration(milliseconds?: number) {
  if (milliseconds === undefined) return "—"
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
  return `${minutes}:${String(remainder).padStart(2, "0")}`
}

function formatTime(value: string | number) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  })
}

function displayValue(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function healthTone(status: DomainHealthControlV1["status"]) {
  if (status === "fresh") return "border-v2-state-border-success bg-v2-state-bg-success text-v2-state-fg-success"
  if (status === "stale") return "border-v2-state-border-warning bg-v2-state-bg-warning text-v2-state-fg-warning"
  return "border-v2-state-border-danger bg-v2-state-bg-danger text-v2-state-fg-danger"
}

function statusDot(status: AgentControlV1["status"]) {
  if (status === "error" || status === "blocked") return "bg-v2-state-fg-danger"
  if (status === "busy" || status === "active") return "bg-v2-state-fg-success"
  return "bg-v2-text-text-faint"
}

function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

function parseSseChunk(chunk: string): unknown {
  const data = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""))
  if (data.length === 0) return undefined
  try {
    return JSON.parse(data.join("\n")) as unknown
  } catch {
    return undefined
  }
}

function isControlInvalidation(value: unknown) {
  if (!value || typeof value !== "object" || !("payload" in value)) return false
  const payload = value.payload
  return !!payload && typeof payload === "object" && "type" in payload && payload.type === "control.invalidated"
}

async function hashRequest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function operationID() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `control-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function SectionHeader(props: { title: string; count: number }) {
  return (
    <div class="flex items-center gap-2">
      <h2 class="text-[14px] leading-5 text-v2-text-text-base [font-weight:530]">{props.title}</h2>
      <span class="rounded-[4px] border border-v2-border-border-base bg-v2-background-bg-layer-02 px-1.5 py-0.5 text-[10px] leading-none text-v2-text-text-muted tabular-nums">
        {props.count}
      </span>
    </div>
  )
}

function EmptyState(props: { children: string }) {
  return (
    <div class="rounded-[8px] border border-dashed border-v2-border-border-base px-4 py-8 text-center text-[13px] text-v2-text-text-muted">
      {props.children}
    </div>
  )
}

export default function Control() {
  const server = useServer()
  const [state, setState] = createStore<ControlState>({
    loading: true,
    refreshing: false,
    prompts: {},
    actions: {},
    events: {},
    eventErrors: {},
    eventsLoading: {},
  })

  const lifetime = new AbortController()
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let overviewRequest: Promise<void> | undefined
  let overviewQueued = false
  const eventRequests = new Map<string, Promise<void>>()

  const authHeaders = (accept = "application/json") => {
    const current = server.current
    if (!current) throw new Error("No server available")
    const headers = new Headers({ accept })
    if (current.http.password) {
      headers.set("authorization", `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`)
    }
    return headers
  }

  const request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const current = server.current
    if (!current) throw new Error("No server available")
    const headers = new Headers(init?.headers)
    const authenticated = authHeaders()
    authenticated.forEach((value, key) => headers.set(key, value))
    const response = await fetch(new URL(path, current.http.url), {
      ...init,
      headers,
      signal: init?.signal ?? lifetime.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      throw new Error(detail || `${response.status} ${response.statusText}`)
    }
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- The control API is not generated in this PR, so its local contract is the response boundary.
    return (await response.json()) as T
  }

  const refreshOverview = (source: RefreshSource) => {
    if (overviewRequest) {
      if (source !== "poll") overviewQueued = true
      return overviewRequest
    }

    const current = (async () => {
      setState("refreshing", true)
      try {
        const snapshot = await request<ControlSnapshotV1>("/control/v1/overview")
        if (lifetime.signal.aborted) return
        setState({ snapshot, error: undefined })
      } catch (cause) {
        if (lifetime.signal.aborted) return
        setState("error", errorMessage(cause))
      } finally {
        if (!lifetime.signal.aborted) setState({ loading: false, refreshing: false })
      }
    })().finally(() => {
      if (overviewRequest !== current) return
      overviewRequest = undefined
      if (!overviewQueued || lifetime.signal.aborted) return
      overviewQueued = false
      queueMicrotask(() => void refreshOverview("queued"))
    })
    overviewRequest = current
    return current
  }

  const refreshWorkflowEvents = (workflowID: string) => {
    const existing = eventRequests.get(workflowID)
    if (existing) return existing
    const afterSeq = state.events[workflowID]?.at(-1)?.seq ?? 0
    const current = (async () => {
      setState("eventsLoading", workflowID, true)
      setState("eventErrors", workflowID, undefined)
      try {
        const events = await request<CrucibleEventControlV1[]>(
          `/control/v1/crucible/${encodeURIComponent(workflowID)}/events?afterSeq=${afterSeq}`,
        )
        if (lifetime.signal.aborted || events.length === 0) return
        const previous = state.events[workflowID] ?? []
        const bySequence = new Map([...previous, ...events].map((event) => [event.seq, event]))
        setState(
          "events",
          workflowID,
          [...bySequence.values()].sort((a, b) => a.seq - b.seq),
        )
      } catch (cause) {
        if (!lifetime.signal.aborted) setState("eventErrors", workflowID, errorMessage(cause))
      } finally {
        if (!lifetime.signal.aborted) setState("eventsLoading", workflowID, false)
      }
    })().finally(() => eventRequests.delete(workflowID))
    eventRequests.set(workflowID, current)
    return current
  }

  const refreshLoadedEvents = () => {
    for (const workflowID of Object.keys(state.events)) void refreshWorkflowEvents(workflowID)
  }

  const readEventStream = async (response: Response) => {
    if (!response.body) throw new Error("The event stream returned no body")
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    while (!lifetime.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      const chunks = buffer.split("\n\n")
      buffer = chunks.pop() ?? ""
      for (const chunk of chunks) {
        if (!isControlInvalidation(parseSseChunk(chunk))) continue
        void refreshOverview("event")
        refreshLoadedEvents()
      }
    }
    if (!lifetime.signal.aborted) throw new Error("The event stream closed")
  }

  const runEventStream = async () => {
    for (let attempt = 0; attempt < SSE_MAX_ATTEMPTS && !lifetime.signal.aborted; attempt++) {
      if (attempt > 0) await sleep(SSE_RETRY_MS, lifetime.signal)
      if (lifetime.signal.aborted) return
      try {
        const current = server.current
        if (!current) return
        const response = await fetch(new URL("/global/event", current.http.url), {
          headers: authHeaders("text/event-stream"),
          signal: lifetime.signal,
        })
        if (!response.ok) throw new Error(`Event stream failed: ${response.status} ${response.statusText}`)
        await readEventStream(response)
      } catch (cause) {
        if (lifetime.signal.aborted) return
        if (attempt === SSE_MAX_ATTEMPTS - 1) {
          console.warn("[control] event stream unavailable; continuing with polling", cause)
        }
      }
    }
  }

  const submitPrompt = async (agent: AgentControlV1, delivery: "steer" | "queue") => {
    const text = state.prompts[agent.id]?.trim()
    if (!text) return
    const kind = delivery === "steer" ? "steer" : "queue"
    setState("actions", agent.id, { kind })
    try {
      const command = { sessionID: agent.id, text, delivery }
      const receipt = await request<CommandReceiptV1>("/control/v1/prompts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, operationID: operationID(), requestHash: await hashRequest(command) }),
      })
      if (!receipt.accepted) throw new Error(receipt.message ?? "The server did not accept this prompt")
      setState("prompts", agent.id, "")
      setState("actions", agent.id, { kind, message: receipt.alreadyHandled ? "Already handled" : "Accepted" })
      await refreshOverview("event")
    } catch (cause) {
      setState("actions", agent.id, { kind, error: errorMessage(cause) })
    }
  }

  const abortAgent = async (agent: AgentControlV1) => {
    if (!window.confirm(`Abort “${agent.title || agent.id}”?`)) return
    setState("actions", agent.id, { kind: "abort" })
    try {
      const command = { sessionID: agent.id }
      const receipt = await request<CommandReceiptV1>("/control/v1/abort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, operationID: operationID(), requestHash: await hashRequest(command) }),
      })
      if (!receipt.accepted) throw new Error(receipt.message ?? "The server did not accept the abort request")
      setState("actions", agent.id, { kind: "abort", message: receipt.alreadyHandled ? "Already handled" : "Accepted" })
      await refreshOverview("event")
    } catch (cause) {
      setState("actions", agent.id, { kind: "abort", error: errorMessage(cause) })
    }
  }

  onMount(() => {
    void refreshOverview("initial")
    void runEventStream()
    pollTimer = setInterval(() => {
      if (!document.hidden) void refreshOverview("poll")
    }, POLL_INTERVAL_MS)
    document.addEventListener("visibilitychange", onVisibilityChange)
  })

  function onVisibilityChange() {
    if (!document.hidden) void refreshOverview("visible")
  }

  onCleanup(() => {
    lifetime.abort()
    if (pollTimer) clearInterval(pollTimer)
    document.removeEventListener("visibilitychange", onVisibilityChange)
  })

  const rootAgents = createMemo(() => state.snapshot?.agents.filter((agent) => !agent.parentID) ?? [])
  const tasksForAgent = (root: AgentControlV1) => {
    const agents = state.snapshot?.agents ?? []
    const descendants = new Set([root.id])
    let changed = true
    while (changed) {
      changed = false
      for (const agent of agents) {
        if (!agent.parentID || descendants.has(agent.id) || !descendants.has(agent.parentID)) continue
        descendants.add(agent.id)
        changed = true
      }
    }
    return state.snapshot?.tasks.filter((task) => descendants.has(task.parentSessionID)) ?? []
  }
  const connectionLabel = createMemo(() => {
    if (state.loading) return "Connecting"
    if (state.error) return "Disconnected"
    return "Connected"
  })
  const connectionDot = createMemo(() => {
    if (state.loading || state.refreshing) return "bg-v2-state-fg-warning"
    if (state.error) return "bg-v2-state-fg-danger"
    return "bg-v2-state-fg-success"
  })

  return (
    <div class="m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <main class="h-full overflow-y-auto px-5 py-5 md:px-8 md:py-7">
        <div class="mx-auto flex w-full max-w-[1160px] flex-col gap-7 pb-10">
          <header class="flex flex-wrap items-center justify-between gap-4">
            <div class="min-w-0">
              <h1 class="text-[22px] leading-7 tracking-[-0.2px] text-v2-text-text-base [font-weight:530]">Control</h1>
              <div class="mt-1 flex min-w-0 items-center gap-2 text-[12px] text-v2-text-text-muted">
                <span class={`h-2 w-2 shrink-0 rounded-full ${connectionDot()}`} />
                <span>{connectionLabel()}</span>
                <Show when={state.snapshot?.capturedAt}>
                  {(capturedAt) => <span class="truncate">Snapshot {formatTime(capturedAt())}</span>}
                </Show>
              </div>
            </div>
            <ButtonV2 onClick={() => void refreshOverview("manual")} disabled={state.refreshing}>
              {state.refreshing ? "Refreshing…" : "Refresh"}
            </ButtonV2>
          </header>

          <Show when={state.error}>
            {(error) => (
              <div class="rounded-[8px] border border-v2-state-border-danger bg-v2-state-bg-danger px-3 py-2 text-[12px] text-v2-state-fg-danger">
                {error()}
              </div>
            )}
          </Show>

          <div class="flex flex-wrap gap-2" aria-label="Control domain health">
            <Show
              when={(state.snapshot?.health.length ?? 0) > 0}
              fallback={<span class="text-[12px] text-v2-text-text-muted">Domain health is not available yet.</span>}
            >
              <For each={state.snapshot?.health}>
                {(health) => (
                  <span
                    class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] capitalize ${healthTone(health.status)}`}
                    title={health.message}
                  >
                    <span class="h-1.5 w-1.5 rounded-full bg-current" />
                    {health.domain}: {health.status}
                  </span>
                )}
              </For>
            </Show>
          </div>

          <section class="flex flex-col gap-3" aria-labelledby="control-agents-heading">
            <div id="control-agents-heading">
              <SectionHeader title="Agents" count={rootAgents().length} />
            </div>
            <Show when={rootAgents().length > 0} fallback={<EmptyState>No active or recent agents.</EmptyState>}>
              <div class="grid gap-2">
                <For each={rootAgents()}>
                  {(agent) => {
                    const tasks = createMemo(() => tasksForAgent(agent))
                    const pending = () => agent.pendingQuestionCount + agent.pendingPermissionCount
                    const busy = () =>
                      !!state.actions[agent.id] && !state.actions[agent.id]?.error && !state.actions[agent.id]?.message
                    return (
                      <details class="group rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01 open:bg-v2-background-bg-layer-02">
                        <summary class="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 marker:hidden [&::-webkit-details-marker]:hidden">
                          <span class={`h-2 w-2 shrink-0 rounded-full ${statusDot(agent.status)}`} />
                          <span class="min-w-[150px] flex-1 truncate text-[13px] text-v2-text-text-base [font-weight:530]">
                            {agent.title || agent.id}
                          </span>
                          <span class="max-w-[220px] truncate text-[11px] text-v2-text-text-muted">
                            {[agent.agent, agent.modelRef].filter(Boolean).join(" · ") || "default agent"}
                          </span>
                          <span class="max-w-[240px] truncate text-[12px] text-v2-text-text-muted">
                            {agent.currentActivity || "idle"}
                          </span>
                          <span class="text-[11px] tabular-nums text-v2-text-text-muted">
                            {formatDuration(agent.elapsedMs)}
                          </span>
                          <span class="text-[11px] text-v2-text-text-muted">
                            {agent.childCount} children · {agent.taskCount} tasks · {pending()} pending
                          </span>
                          <span class="text-[12px] text-v2-text-text-faint transition-transform group-open:rotate-90">
                            ›
                          </span>
                        </summary>

                        <div class="border-t border-v2-border-border-base px-3 py-3">
                          <div class="mb-3 grid gap-1 text-[11px] text-v2-text-text-muted sm:grid-cols-3">
                            <span>{agent.pendingQuestionCount} pending questions</span>
                            <span>{agent.pendingPermissionCount} pending permissions</span>
                            <span class="truncate" title={agent.directory}>
                              {agent.directory}
                            </span>
                          </div>

                          <Show
                            when={tasks().length > 0}
                            fallback={
                              <p class="mb-3 text-[12px] text-v2-text-text-muted">No tasks for this agent tree.</p>
                            }
                          >
                            <div class="mb-3 overflow-hidden rounded-[6px] border border-v2-border-border-base">
                              <For each={tasks()}>
                                {(task) => (
                                  <div class="grid gap-1 border-b border-v2-border-border-base px-2.5 py-2 text-[11px] last:border-b-0 md:grid-cols-[minmax(120px,0.7fr)_minmax(100px,0.5fr)_90px_minmax(180px,1.5fr)]">
                                    <span class="truncate font-mono text-v2-text-text-base" title={task.id}>
                                      {task.id}
                                    </span>
                                    <span class="truncate text-v2-text-text-muted">
                                      {task.subagentType} · {task.mode}
                                    </span>
                                    <span class="text-v2-text-text-muted">{task.status}</span>
                                    <span
                                      class={
                                        task.lastError
                                          ? "truncate text-v2-state-fg-danger"
                                          : "truncate text-v2-text-text-muted"
                                      }
                                      title={task.lastError ?? task.resultSummary}
                                    >
                                      {task.lastError ?? task.resultSummary ?? "—"}
                                    </span>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>

                          <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <TextInputV2
                              class="w-full! flex-1!"
                              value={state.prompts[agent.id] ?? ""}
                              onInput={(event) => setState("prompts", agent.id, event.currentTarget.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                                  void submitPrompt(agent, "steer")
                              }}
                              placeholder="Prompt this agent…"
                              disabled={busy()}
                            />
                            <div class="flex shrink-0 items-center gap-1">
                              <ButtonV2
                                size="small"
                                disabled={busy() || !state.prompts[agent.id]?.trim()}
                                onClick={() => void submitPrompt(agent, "steer")}
                              >
                                Steer
                              </ButtonV2>
                              <ButtonV2
                                size="small"
                                variant="ghost"
                                disabled={busy() || !state.prompts[agent.id]?.trim()}
                                onClick={() => void submitPrompt(agent, "queue")}
                              >
                                Queue
                              </ButtonV2>
                              <ButtonV2
                                size="small"
                                variant="ghost-muted"
                                disabled={busy()}
                                onClick={() => void abortAgent(agent)}
                              >
                                Abort
                              </ButtonV2>
                            </div>
                          </div>
                          <Show when={state.actions[agent.id]?.error ?? state.actions[agent.id]?.message}>
                            <p
                              class={`mt-2 text-[11px] ${state.actions[agent.id]?.error ? "text-v2-state-fg-danger" : "text-v2-state-fg-success"}`}
                            >
                              {state.actions[agent.id]?.error ?? state.actions[agent.id]?.message}
                            </p>
                          </Show>
                        </div>
                      </details>
                    )
                  }}
                </For>
              </div>
            </Show>
          </section>

          <section class="flex flex-col gap-3" aria-labelledby="control-crucible-heading">
            <div id="control-crucible-heading">
              <SectionHeader title="Crucible" count={state.snapshot?.crucible.length ?? 0} />
            </div>
            <Show
              when={(state.snapshot?.crucible.length ?? 0) > 0}
              fallback={<EmptyState>No Crucible workflows.</EmptyState>}
            >
              <div class="grid gap-2">
                <For each={state.snapshot?.crucible}>
                  {(workflow) => (
                    <details
                      class="group rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01 open:bg-v2-background-bg-layer-02"
                      onToggle={(event) => {
                        if (event.currentTarget.open) void refreshWorkflowEvents(workflow.workflowId)
                      }}
                    >
                      <summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5 marker:hidden [&::-webkit-details-marker]:hidden">
                        <span class="min-w-[180px] flex-1 truncate text-[13px] text-v2-text-text-base [font-weight:530]">
                          {workflow.workspaceSlug || workflow.workflowId}
                        </span>
                        <span class="rounded-[4px] border border-v2-border-border-base bg-v2-background-bg-layer-03 px-2 py-0.5 text-[10px] text-v2-text-text-muted">
                          {workflow.stage} · {workflow.status} · {workflow.phase}
                        </span>
                        <span class="text-[11px] text-v2-text-text-muted">
                          Updated {formatTime(workflow.updatedAt)}
                        </span>
                        <span class="text-[12px] text-v2-text-text-faint transition-transform group-open:rotate-90">
                          ›
                        </span>
                      </summary>
                      <div class="border-t border-v2-border-border-base px-3 py-3">
                        <Show when={workflow.blocker !== undefined}>
                          <p class="mb-2 text-[11px] text-v2-state-fg-warning">
                            <span class="[font-weight:530]">Blocker:</span> {displayValue(workflow.blocker)}
                          </p>
                        </Show>
                        <Show when={workflow.terminal !== undefined}>
                          <p class="mb-2 text-[11px] text-v2-text-text-muted">
                            <span class="[font-weight:530]">Terminal:</span> {displayValue(workflow.terminal)}
                          </p>
                        </Show>
                        <Show when={state.eventErrors[workflow.workflowId]}>
                          {(error) => <p class="mb-2 text-[11px] text-v2-state-fg-danger">{error()}</p>}
                        </Show>
                        <Show
                          when={(state.events[workflow.workflowId]?.length ?? 0) > 0}
                          fallback={
                            <p class="text-[12px] text-v2-text-text-muted">
                              {state.eventsLoading[workflow.workflowId] ? "Loading events…" : "No workflow events."}
                            </p>
                          }
                        >
                          <ol class="relative ml-1 border-l border-v2-border-border-strong pl-4">
                            <For each={state.events[workflow.workflowId]}>
                              {(item) => (
                                <li class="relative pb-3 last:pb-0">
                                  <span class="absolute -left-[19px] top-1.5 h-2 w-2 rounded-full border border-v2-border-border-strong bg-v2-background-bg-base" />
                                  <div class="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                                    <span class="font-mono text-v2-text-text-faint">#{item.seq}</span>
                                    <span class="text-v2-text-text-base [font-weight:530]">{item.type}</span>
                                    <span class="text-v2-text-text-muted">{formatTime(item.occurredAt)}</span>
                                  </div>
                                  <Show when={item.message ?? item.summary}>
                                    {(message) => <p class="mt-0.5 text-[12px] text-v2-text-text-muted">{message()}</p>}
                                  </Show>
                                </li>
                              )}
                            </For>
                          </ol>
                        </Show>
                      </div>
                    </details>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <section class="flex flex-col gap-3" aria-labelledby="control-campaigns-heading">
            <div id="control-campaigns-heading">
              <SectionHeader title="Campaigns" count={state.snapshot?.campaigns.length ?? 0} />
            </div>
            <Show when={(state.snapshot?.campaigns.length ?? 0) > 0} fallback={<EmptyState>No campaigns.</EmptyState>}>
              <div class="overflow-hidden rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-layer-01">
                <For each={state.snapshot?.campaigns}>
                  {(campaign) => (
                    <div class="grid gap-1 border-b border-v2-border-border-base px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(200px,1fr)_130px_100px_90px_100px] md:items-center">
                      <span class="truncate text-[13px] text-v2-text-text-base [font-weight:530]" title={campaign.goal}>
                        {campaign.goal}
                      </span>
                      <span class="truncate text-[11px] text-v2-text-text-muted">{campaign.agent}</span>
                      <span class="text-[11px] text-v2-text-text-muted">{campaign.status}</span>
                      <span class="text-[11px] tabular-nums text-v2-text-text-muted">{campaign.rounds} rounds</span>
                      <span class="text-[11px] tabular-nums text-v2-text-text-muted">
                        {campaign.candidateCount} candidates
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </div>
      </main>
    </div>
  )
}
