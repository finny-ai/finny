import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import type { Agent } from "./agent"
import { effectiveFundRuntimePermission, isFundRuntimeAgent } from "./fund-policy"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  const protectedFundRuntime = isFundRuntimeAgent(input.subagent.name)
  const effectivePermission = effectiveFundRuntimePermission(input.subagent.name, input.subagent.permission)
  const canTask = protectedFundRuntime
    ? Permission.evaluate("task", "*", effectivePermission).action === "allow"
    : input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = protectedFundRuntime
    ? Permission.evaluate("todowrite", "*", effectivePermission).action === "allow"
    : input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter((rule) =>
      isFundRuntimeAgent(input.subagent.name)
        ? rule.action === "deny"
        : rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
