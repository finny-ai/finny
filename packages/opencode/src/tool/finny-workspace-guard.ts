import * as path from "path"
import { Effect } from "effect"
import { algoDir, getSessionWorkspace } from "@finny-ai/core/algo"
import type { Tool } from "./tool"
import { InstanceState } from "@/effect/instance-state"

export function sameOrInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function isRepoLocalAlgoNewsPath(filepath: string, worktree: string) {
  const relative = path.relative(path.join(worktree, "algos"), filepath)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false
  const parts = relative.split(path.sep)
  return parts.length >= 3 && parts[1] === "data" && parts[2] === "news"
}

function isHeadlineRollPath(newsRoot: string, filepath: string) {
  return sameOrInside(path.join(newsRoot, "headlines"), filepath)
}

function isRepoLocalAlgoSecPath(filepath: string, worktree: string) {
  const relative = path.relative(path.join(worktree, "algos"), filepath)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false
  const parts = relative.split(path.sep)
  return parts.length >= 3 && parts[1] === "data" && parts[2] === "sec"
}

function isRepoLocalAlgoSentimentPath(filepath: string, worktree: string) {
  const relative = path.relative(path.join(worktree, "algos"), filepath)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false
  const parts = relative.split(path.sep)
  return parts.length >= 4 && parts[1] === "data" && parts[2] === "sentiment" && parts[3] === "body"
}

export const assertResearcherWorkspaceNewsPath = Effect.fn("FinnyWorkspaceGuard.assertResearcherWorkspaceNewsPath")(
  function* (ctx: Tool.Context, filepath: string, operation: "read" | "write" | "edit") {
    if (ctx.agent !== "news_agent" && ctx.agent !== "researcher") return
    const agentLabel = ctx.agent === "researcher" ? "Researcher" : "News Agent"

    const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
    if (!workspace) {
      const instance = yield* InstanceState.context
      if (operation === "read" && !isRepoLocalAlgoNewsPath(filepath, instance.worktree)) return
      return yield* Effect.die(
        new Error(
          `${agentLabel} ${operation} blocked: ${filepath} is not allowed because no workspace_news_dir is bound.`,
        ),
      )
    }

    const newsRoot = path.join(algoDir(workspace), "data", "news")
    if (sameOrInside(newsRoot, filepath)) {
      if ((operation === "write" || operation === "edit") && isHeadlineRollPath(newsRoot, filepath)) {
        return yield* Effect.die(
          new Error(
            `${agentLabel} ${operation} blocked: headline rolls are disabled by default. Write one compact note under ${path.join(newsRoot, "body")}.`,
          ),
        )
      }
      return
    }

    return yield* Effect.die(
      new Error(
        `${agentLabel} ${operation} blocked: ${filepath} is outside the session workspace news directory. Use ${newsRoot}.`,
      ),
    )
  },
)

export const assertSecAgentWorkspaceSecPath = Effect.fn("FinnyWorkspaceGuard.assertSecAgentWorkspaceSecPath")(
  function* (ctx: Tool.Context, filepath: string, operation: "read" | "write" | "edit") {
    if (ctx.agent !== "sec_agent") return

    const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
    if (!workspace) {
      const instance = yield* InstanceState.context
      if (operation === "read" && !isRepoLocalAlgoSecPath(filepath, instance.worktree)) return
      return yield* Effect.die(
        new Error(`SEC Agent ${operation} blocked: ${filepath} is not allowed because no allowed_sec_dir is bound.`),
      )
    }

    const secRoot = path.join(algoDir(workspace), "data", "sec")
    if (sameOrInside(secRoot, filepath)) return

    return yield* Effect.die(
      new Error(
        `SEC Agent ${operation} blocked: ${filepath} is outside the session workspace SEC directory. Use ${secRoot}.`,
      ),
    )
  },
)

export const assertSentimentAgentWorkspacePath = Effect.fn("FinnyWorkspaceGuard.assertSentimentAgentWorkspacePath")(
  function* (ctx: Tool.Context, filepath: string, operation: "read" | "write" | "edit") {
    if (ctx.agent !== "sentiment_agent") return

    const workspace = yield* Effect.promise(() => getSessionWorkspace(ctx.sessionID).catch(() => null))
    if (!workspace) {
      const instance = yield* InstanceState.context
      if (operation === "read" && !isRepoLocalAlgoSentimentPath(filepath, instance.worktree)) return
      return yield* Effect.die(
        new Error(
          `Sentiment Agent ${operation} blocked: ${filepath} is not allowed because no allowed_sentiment_dir is bound.`,
        ),
      )
    }

    const sentimentBodyRoot = path.join(algoDir(workspace), "data", "sentiment", "body")
    if (sameOrInside(sentimentBodyRoot, filepath)) return

    return yield* Effect.die(
      new Error(
        `Sentiment Agent ${operation} blocked: ${filepath} is outside the session workspace sentiment body directory. Use ${sentimentBodyRoot}.`,
      ),
    )
  },
)
