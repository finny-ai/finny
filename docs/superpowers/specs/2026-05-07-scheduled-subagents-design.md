# Scheduled sub-agents — design

**Status:** approved, ready for implementation plan
**Date:** 2026-05-07
**Owner:** @Jaiminp007 (fork maintainer)

## Goal

Let the main Finny agent (Build / Research / Chat) spawn **scheduled sub-agents** that wake up on a cron cadence, inspect a single algorithm's current performance, and post their findings inline into the spawning session.

The user's mental model: "I'm iterating on a strategy. Set a watcher to check on it every 15 minutes and tell me if anything material changes."

## Context — what already exists

Finny is a fork of [`anomalyco/opencode`](https://github.com/anomalyco/opencode). Almost all the runtime pieces this feature needs are already in the fork:

- **`packages/opencode/src/cron/`** (added in fork PR #10, no upstream equivalent):
  - `Job.Schema` — discriminated union of `check` (deterministic price/PnL/position rule) and `prompt` (LLM run) jobs.
  - `Scheduler` — 60s tick loop, market-aware, timezone-aware, auto-pauses a job after 5 consecutive failures.
  - `CronStorage` — file-backed (`~/.local/share/finny/cron/jobs.json`) with `Flock`-protected reads/writes and a per-job `runs/<jobID>.jsonl` log.
  - `PromptRunner` — already does the headless flow we need: in-process SDK against `Server.Default()`, creates a throwaway session, prompts an agent, collects assistant text, deletes the session.
  - `Notify` — macOS `osascript` notifications.
  - `Schedule.matches` — 5-field cron + timezone matching.
- **`packages/opencode/src/agent/` + `packages/opencode/src/tool/task.ts`** — primary/subagent abstraction with isolated sessions and per-agent tool permissions, used by the existing synchronous `task` tool.
- **`packages/opencode/src/tool/algorithm-*`, `tool/backtest-*`, `cron/alpaca-data.ts`, `live/`** — read-only algorithm metadata, backtest history, and Alpaca live-data tools the watcher will call.

### Upstream alignment check

Upstream OpenCode has tried this kind of feature several times — PR #12417 (Automations), PR #13414, PR #13413, PR #20454 — **all closed without merge**. The current adjacent active work is PR #23575 (`/loop`, `/proactive`), but that's an in-session timer paradigm rather than cron jobs. Finny is in clear blue water.

The closest-shape upstream attempt (PR #12417) used `Automation { name, projects, prompt, schedule, enabled }` + `AutomationRun` history. Finny's existing `Job.Schema` already mirrors this by coincidence; the only field missing for full alignment is `parentSessionID`, which we need anyway. Cheap insurance.

### Reference: Claude Code's `CronCreate`

CC's tool has a few patterns we adopt directly:

- 5-field cron strings in user's local TZ (no schedule DSL).
- **Idle-only firing** — never injects mid-tool-call.
- `durable: false` default = session-only; `durable: true` = persisted.
- **Recurring auto-expires after 7 days.**
- **Off-minute jitter** to spread load across users hitting external APIs.

## Approach

A small integration layer on top of the existing cron + agent systems:

1. Add four optional fields to `Job.Schema` (`parentSessionID`, `recurring`, `durable`, `expiresAt`).
2. Branch `PromptRunner` so jobs with a `parentSessionID` deliver findings as **inline messages in the parent session** (idle-gated) instead of only OS notifications.
3. Add three LLM-callable tools (`schedule_subagent`, `list_subagents`, `stop_subagent`) so the main agent can spawn / list / stop watchers from inside a session.
4. Add a constrained `watcher` agent definition (read-only data tools only, focused report-only system prompt).

All new files live in fork-only territory (`.opencode/agent/`, new `tool/` files, new `cron/inject.ts`). The only edit to existing code is one branch in `PromptRunner.run` and one `if expiresAt past` guard in `Scheduler.runJob` — both in fork-only files.

### Approaches considered and rejected

- **B. Promote watchers to first-class subagents** managed by a new `SubagentManager` that owns both schedule and lifecycle, threading findings through the `task`-tool result path. Single mental model, but a real refactor of session/prompt internals; not justified by v1 scope.
- **C. TUI-only `setInterval` re-prompting the active session.** Throws away the existing cron infra and pollutes the user's chat with the watcher's intermediate tool calls. No isolation.

## Architecture

```
Scheduler.tick (every 60s)
   └─ if Schedule.matches(job, now)
        └─ runJob(job)
             ├─ if expiresAt past: enabled=false, return
             ├─ kind=prompt:
             │   └─ PromptRunner.run(job)
             │        ├─ Server.Default() in-process SDK
             │        ├─ create throwaway session "watcher:<algo>:<ts>"
             │        ├─ prompt(agent="watcher", text=job.prompt)
             │        ├─ collect assistant text
             │        ├─ delete throwaway session
             │        └─ return { ok, text }
             └─ if job.parentSessionID:
                   └─ Inject.post(parentSessionID, formatted-finding)
                        └─ if parent busy: queue; flush on session.status=idle
                        └─ if parent gone: fall back to OS Notify
```

Why a throwaway session: isolates the watcher's tool calls and intermediate reasoning from the user's chat history. Only the final summary lands in the parent. Same pattern as `tool/task.ts` already uses for synchronous subagents.

## Components

### Modify: `cron/job.ts`

Extend the private `Common` zod object:

```ts
parentSessionID: z.string().optional(),
recurring: z.boolean().default(true),
durable: z.boolean().default(false),
expiresAt: z.number().int().optional(),  // ms epoch; auto-set by tool when recurring
```

`Job.Schema` already serializes through these defaults via the existing discriminated-union parser. Existing records on disk that lack the new fields parse cleanly because all four are optional / defaulted.

### Modify: `cron/scheduler.ts`

In `runJob`, before the `kind === "prompt"` branch:

```ts
if (job.expiresAt && job.expiresAt <= startedAt) {
  await CronStorage.update(job.id, { enabled: false })
  return { ...record, status: "skipped", note: "expired" }
}
```

In a new `Scheduler.bootSweep()` called from the TUI entrypoint:

```ts
// drop non-durable jobs from a previous TUI session
const stale = (await CronStorage.list()).filter(j => !j.durable && j.parentSessionID)
for (const j of stale) await CronStorage.remove(j.id)
```

### Modify: `cron/prompt-runner.ts`

After the existing `text` collection (around line 116), branch on `parentSessionID`:

```ts
if (job.parentSessionID) {
  await Inject.post(job.parentSessionID, formatFinding(job, text))
} else {
  await Notify.send({
    title: job.notification.title || job.name,
    body: (job.notification.body || text).slice(0, 240),
  })
}
```

`formatFinding(job, text)` returns `[watcher: <job.name>] <text>` (one paragraph).

### New: `cron/inject.ts`

~80 lines. Public surface:

```ts
namespace Inject {
  function post(sessionID: string, text: string): Promise<void>
}
```

Behavior:

1. Verify the session exists via the in-process SDK; if not, fall back to `Notify.send` and return.
2. Get current `session.status`; if `idle`, post immediately as a `role: user` message with the formatted text.
3. If busy, push onto an in-memory queue keyed by `sessionID`. Subscribe (once per `sessionID`) to `session.status` events. On the next `idle` event, drain that session's queue in FIFO order, then unsubscribe.
4. Each queued entry has an enqueue timestamp; drop entries older than 24h with a warn-log.

**Why role=user**: `assistant` confuses the LLM ("did I say that?"); `system` is unreliable for getting the model to react. `role: user` cleanly models "the watcher is acting on the user's behalf — like the user pasted in a status update." The main agent only reacts on the user's *next* prompt, never autonomously.

### New: `tool/schedule_subagent.ts` (+ `.txt` description)

LLM-callable. Parameters:

```ts
{
  algorithmId: string,         // ties watcher to one algorithm
  cron: string,                // 5-field cron, local TZ (CC convention)
  recurring?: boolean = true,
  durable?: boolean = false,   // accepted for forward-compat; ignored in v1
  notes?: string,              // optional extra context appended to the watcher prompt
}
```

Behavior:

1. Validate the cron string by calling `Schedule.matches(cron, new Date())` (throws on invalid). Catch and return a tool error so the LLM can tell the user immediately, not 60s later.
2. Verify the algorithm exists by calling the same registry function that `tool/algorithm-get.ts` wraps (lookup by `algorithmId`). Fail fast with a clear error if not.
3. Apply CC-style off-minute jitter by **rewriting the cron string at create time**: derive a deterministic offset `o = hash(jobID) % 7` minutes, then shift the minute field. E.g. `*/15 * * * *` with `o=4` → `4,19,34,49 * * * *`. No new schema field; `Schedule.matches` already handles arbitrary cron strings. Store the rewritten string on `job.schedule` and the original on `job.scheduleSource`.
4. Build the per-fire prompt text from a fixed template that the tool fills in synchronously at create time: algorithm name, symbols, last known metrics from the registry, plus `notes` if provided. This concrete text is stored in `job.prompt.text` — no runtime templating engine is needed.
5. Stamp `parentSessionID = ctx.sessionID`. If `recurring`, set `expiresAt = now + 7 * 24 * 3600 * 1000`.
6. `CronStorage.create(job)`.
7. Return `{ jobID, name, schedule, expiresAt }`. **Soft warning**: compute estimated runs/hour from the cron expression (e.g. `*/15 * * * *` → 4, `0 * * * *` → 1, `*/5 * * * *` → 12) for every active watcher with the same `parentSessionID`; if the sum exceeds 20, append a warning string to the tool result so the LLM can flag the cost to the user.

### New: `tool/list_subagents.ts`

Returns active jobs filtered to `parentSessionID === ctx.sessionID`. Output includes `id`, `name`, `schedule`, `enabled`, `lastRunAt`, `lastFiredAt`, `failureCount`, `expiresAt`. The main agent only sees its own watchers — keeps multi-session noise out.

### New: `tool/stop_subagent.ts`

Parameters: `{ jobID?: string, name?: string }`. Sets `enabled = false` (soft stop — in-flight run completes and posts; future ticks skip). Document the soft-stop semantics in the tool description so the LLM can explain to the user.

### New: `.opencode/agent/watcher.md`

Fork-only file (no upstream conflict).

```yaml
---
mode: subagent
description: Periodically inspects a trading algorithm's performance and reports material changes.
tools:
  "*": false
  algorithm-get: true
  backtest-history: true
  alpaca-data: true
  read: true
---

You are a performance watcher for trading algorithms. The user-message you receive on each fire identifies which algorithm to inspect, its symbols, and its last known metrics.

On each invocation:
1. Fetch current price and recent P&L for the named algorithm's symbols.
2. Compare against the baseline included in the user message.
3. Report only **material changes**: ≥ 5% PnL move, drawdown breach, win-rate shift, regime flip, kill-switch trip.
4. One short paragraph maximum. If nothing material has changed, respond exactly: "No change."

You may not propose code edits, run backtests, place trades, or schedule additional watchers.
```

The `model` field is intentionally omitted — model is inherited from the spawning session at fire time (matches existing `tool/task.ts` behavior). The per-fire **user message** carries the algorithm name, symbols, and last metrics, so the system prompt stays static and no runtime templating engine is needed.

## Data flow

### Spawn flow (synchronous)

```
user prompts main agent ("watch this algo every 15min")
  → main agent calls schedule_subagent({algorithmId, cron})
  → tool stamps parentSessionID = current session, expiresAt = now + 7d
  → CronStorage.create(job)
  → tool returns { jobID, name, schedule } as tool result
  → main agent confirms inline to the user
```

### Fire flow (asynchronous, every scheduler tick)

```
Scheduler.tick → Schedule.matches → runJob
  → if expiresAt past: enabled=false, return
  → PromptRunner.run(job)
       creates throwaway session, prompts watcher agent, collects text, deletes session
  → if parentSessionID set: Inject.post(parentSessionID, formatted finding)
       waits for session.status=idle, then posts as role=user message
  → CronStorage.appendRun(record); update lastFiredAt
```

## Edge cases

| Case | Behavior |
|---|---|
| Parent session is mid-tool-call when watcher finishes | `Inject.post` queues; subscribes to `session.status`; flushes on next idle. **Max queue age 24h** — drop with warn-log if never drained. |
| User stops watcher while it's mid-fire | `stop_subagent` does **soft stop**: `enabled=false`. In-flight run completes (its inject still posts). Future ticks skip. |
| Watcher fires after `expiresAt` is past | Skipped before entering `PromptRunner`. Marked `enabled=false`. One log line; no notification. |
| Watcher takes >5 min | Existing `TIMEOUT_MS = 5*60_000` kicks in; `{ok:false, error:"timeout"}`; failure count increments; 5 timeouts in a row → auto-pause (existing logic). |
| Algorithm is deleted between fires | `algorithm-get` errors inside watcher; watcher reports the error as its finding once; failure count increments; auto-pause after 5. |
| Parent session deleted while job is enabled | `Inject.post` checks session existence; if missing, falls back to `Notify.send` so the finding isn't lost. Job marked for removal on next tick. |
| Two watchers fire in same 60s window | Scheduler's `for` loop is sequential, so LLM runs serialize. No concurrent token spend on same machine. |
| Multiple watchers for same algorithm | Allowed — different cadences are valid (e.g., 5-min check + 1-hour deep review). `list_subagents` shows all. |
| User opens a 2nd Finny TUI on same machine | `CronStorage` is `Flock`-protected. Second TUI's scheduler acquires a process-level lock on start; if the lock is held, second scheduler is a no-op (jobs still listed/managed in TUI 2, just not fired by it). |
| Token-cost runaway | **v1: soft warning** in `schedule_subagent` result if `active watchers × estimated runs/hour > 20`. No hard cap. |
| Cron string is invalid | Caught at create-time inside `schedule_subagent`; tool returns error so the LLM tells the user immediately. |
| Same-cadence watchers across users hit yfinance/Alpaca synchronously | Off-minute jitter on `Schedule.matches` (deterministic per-job offset). |

## Testing strategy

Layered, mostly unit, one E2E smoke. Use `bun test` and follow existing patterns in `cron/*.test.ts`.

1. **`cron/job.test.ts`** — defaults round-trip; back-compat with records lacking new fields; rejection of negative `expiresAt`.
2. **`cron/storage.test.ts`** (extending existing) — boot sweep drops non-durable parent-tied jobs; `parentSessionID` survives serialize/deserialize; `Flock` holds under concurrent writes.
3. **`cron/scheduler.test.ts`** — past `expiresAt` auto-disables before run; `expiresAt` mid-run lets it finish; failure-count auto-pause unaffected.
4. **`cron/prompt-runner.test.ts`** — given `parentSessionID`, `Inject.post` is called and `Notify.send` is **not**; missing parent falls back to `Notify.send`.
5. **`cron/inject.test.ts`** — post-while-busy queues; idle event drains FIFO; queue >24h drops; multi-session queues are independent.
6. **`tool/schedule_subagent.test.ts`** — invalid cron string returns error pre-storage; `parentSessionID` is stamped from `ctx.sessionID`, never user-provided; soft warning appears past threshold; `list_subagents` filters by `parentSessionID`.
7. **E2E smoke** — spawn watcher via tool → `Scheduler.runOnce(jobID)` → assert `role=user` message with `[watcher: ...]` prefix lands in parent session.

**Manual smoke before merge**: open Finny TUI, ask main agent to "watch the BTC mean-reversion strategy every 5 minutes", let two ticks fire, verify both findings appear inline, run `stop_subagent`, verify next tick is silent.

## Non-goals (v1)

Calling these out so they don't sneak into scope.

1. Watcher cannot propose code edits or run backtests — toolset locked to read-only data tools.
2. Watcher cannot spawn nested watchers — `schedule_subagent` denied in `watcher.md`.
3. `durable: true` is accepted as a parameter for forward-compat but **ignored**; all v1 jobs drop on TUI exit.
4. No runtime prompt-templating tokens (`{{date}}`, `{{session.latest}}` etc.). The per-fire prompt text is built once at `schedule_subagent` time from current algorithm state, stored as concrete text on the job, and sent as-is on every fire. If algorithm metrics change during the watcher's lifetime, that's fine — the watcher pulls fresh data via `algorithm-get` and `alpaca-data` at fire time. The stored prompt only carries the *baseline* and *what to look at*.
5. One algorithm per watcher.
6. No `/agents` slash command in v1 — manage via existing `cron list` / `cron remove` CLI. Add slash command in v1.5 if friction shows up.
7. No multi-machine sync; no Convex sync of cron jobs.
8. No Slack / email / desktop-app delivery — inline message + OS-notify fallback only.
9. No hard token-budget cap.
10. No second-TUI concurrent firing — only the lock-holder fires; other TUIs can read/edit.

## Risks (accepted in v1)

- **Token cost is real**: a watcher firing every 15 min for 7 days = 672 LLM calls. Mitigated by soft warning + 7-day auto-expire.
- **Idle-gating could starve** a watcher if user keeps the TUI in a perpetual tool loop. Mitigated by 24h queue cap + OS-notify fallback.
- **Upstream may land their own automation system later**. Mitigated by keeping all new files in fork-only territory and aligning the data shape to PR #12417's `Automation` model where free.

## Future work

- `durable: true` path using existing `cron/autostart-macos.ts` for jobs that survive TUI close.
- Prompt-templating tokens (align fully with PR #12417 shape).
- `/agents` slash command (`list`, `stop`, `pause`, `resume`).
- Hard token-budget cap.
- Watcher cooldowns on prompt jobs (currently only `check` jobs cool down).
- Cross-session findings dashboard.

## References

- Local cron infra (fork-only, PR #10): `packages/opencode/src/cron/`
- Existing synchronous subagent tool: `packages/opencode/src/tool/task.ts`
- Upstream automations attempt (closed unmerged): https://github.com/anomalyco/opencode/pull/12417
- Upstream `/loop` direction (open): https://github.com/anomalyco/opencode/pull/23575
- Open user demand: anomalyco/opencode#11232, #25395, #5887, #26055, #18001, #19215, #23775
- Third-party plugin in use today: https://github.com/different-ai/opencode-scheduler
