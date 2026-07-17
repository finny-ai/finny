import type { SessionStatus } from "@opencode-ai/sdk/v2"

type StepStatus = "active" | "done"

export interface PreflightStep {
  message: string
  status: StepStatus
}

export function toPreflightSteps(messages: string[], done: boolean): PreflightStep[] {
  if (messages.length === 0) return []
  return messages.map((message, index) => ({
    message,
    status: index < messages.length - 1 || done ? "done" : "active",
  }))
}

export function preflightStepsFromStatus(status: SessionStatus | undefined): PreflightStep[] {
  if (!status || status.type !== "preflight") return []
  const messages = status.steps?.length ? status.steps : [status.message]
  return toPreflightSteps(messages, status.phase === "ready")
}

export function appendPreflightStep(steps: PreflightStep[], message: string, done: boolean): PreflightStep[] {
  const last = steps[steps.length - 1]
  if (last?.message === message) {
    if (done && last.status === "active") {
      return steps.map((step, index) => (index === steps.length - 1 ? { ...step, status: "done" } : step))
    }
    return steps
  }

  const next = steps.map((step) => (step.status === "active" ? { ...step, status: "done" as const } : step))
  return [...next, { message, status: done ? "done" : "active" }]
}
