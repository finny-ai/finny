import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"

import { Plugin } from "@/plugin"
import type { ToolHookContext } from "@opencode-ai/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"
import { EffectBridge } from "@/effect/bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { runTelemetryAttributes, sessionTelemetryAttributes, withTelemetrySpan } from "@/telemetry/run-attributes"
import { runToolHookLifecycle } from "./tool-hook-lifecycle"
import { contextPhaseExecutionBlock, type ContextPhaseGate } from "@/task/strategy-context"
import { effectiveFundRuntimePermission, isFundRuntimeAgent } from "@/agent/fund-policy"

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  definitions?: Tool.Def[]
  includeMcpTools?: boolean
  strategyContextGate?: ContextPhaseGate
}) {
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const effectivePermission = effectiveFundRuntimePermission(
    input.agent.name,
    input.agent.permission,
    input.session.permission ?? [],
  )

  const hookContext = (toolID: string, callID: string): ToolHookContext => ({
    tool: toolID,
    sessionID: input.session.id,
    callID,
    messageID: input.processor.message.id,
    parentSessionID: input.session.parentID,
    agent: input.agent.name,
  })

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    parentSessionID: input.session.parentID,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: effectivePermission,
        })
        .pipe(Effect.orDie),
  })

  const definitions =
    input.definitions ??
    (yield* registry.tools({
      modelID: ModelV2.ID.make(input.model.api.id),
      providerID: input.model.providerID,
      agent: input.agent,
    }))

  const executeRegisteredTool = (item: Tool.Def, runtimeArgs: any, options: ToolExecutionOptions) =>
    Effect.gen(function* () {
      const ctx = context(runtimeArgs, options)
      const blocked = contextPhaseExecutionBlock(item.id, input.strategyContextGate)
      const result = blocked ?? (yield* item.execute(runtimeArgs, ctx))
      const output = {
        ...result,
        attachments: result.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID: ctx.sessionID,
          messageID: input.processor.message.id,
        })),
      }
      if (options.abortSignal?.aborted) {
        yield* input.processor.completeToolCall(options.toolCallId, output)
      }
      return output
    })

  for (const item of definitions) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        if (isFundRuntimeAgent(input.agent.name)) {
          return run.promise(executeRegisteredTool(item, args, options))
        }
        const hook = hookContext(item.id, options.toolCallId)
        return run.promise(
          runToolHookLifecycle({
            plugin,
            context: hook,
            args,
            execute: (runtimeArgs) => executeRegisteredTool(item, runtimeArgs, options),
          }).pipe(Effect.map(({ output }) => output)),
        )
      },
    })
  }

  const mcpTools = input.includeMcpTools === false ? {} : yield* mcp.tools()
  for (const [key, item] of Object.entries(mcpTools)) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    type MCPResult = Awaited<ReturnType<NonNullable<typeof execute>>>
    type MCPContent = MCPResult["content"][number]
    type MCPAttachment = Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">

    const appendResource = (
      resource: Extract<MCPContent, { type: "resource" }>["resource"],
      textParts: string[],
      attachments: MCPAttachment[],
    ) => {
      if (resource.text) textParts.push(resource.text)
      if (!resource.blob) return
      const mime = resource.mimeType ?? "application/octet-stream"
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${resource.blob}`,
        filename: resource.uri,
      })
    }

    const appendContent = (contentItem: MCPContent, textParts: string[], attachments: MCPAttachment[]) => {
      if (contentItem.type === "text") return textParts.push(contentItem.text)
      if (contentItem.type === "image") {
        return attachments.push({
          type: "file",
          mime: contentItem.mimeType,
          url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
        })
      }
      if (contentItem.type === "resource") appendResource(contentItem.resource, textParts, attachments)
    }

    const collectContent = (content: MCPResult["content"]) => {
      const textParts: string[] = []
      const attachments: MCPAttachment[] = []
      for (const contentItem of content) appendContent(contentItem, textParts, attachments)
      return { textParts, attachments }
    }

    const requestMcpTool = (runtimeArgs: any, opts: ToolExecutionOptions, ctx: Tool.Context) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
        return yield* Effect.promise(() => execute(runtimeArgs, opts))
      }).pipe(
        withTelemetrySpan("finny.tool.execute", {
          "tool.name": key,
          "tool.call_id": opts.toolCallId,
          ...sessionTelemetryAttributes(ctx.sessionID, ctx.parentSessionID),
          "message.id": input.processor.message.id,
          ...runTelemetryAttributes(),
        }),
        Effect.withSpan("Tool.execute", {
          attributes: {
            "tool.name": key,
            "tool.call_id": opts.toolCallId,
            ...sessionTelemetryAttributes(ctx.sessionID, ctx.parentSessionID),
            "message.id": input.processor.message.id,
            ...runTelemetryAttributes(),
          },
        }),
      )

    const executeMcpTool = (runtimeArgs: any, opts: ToolExecutionOptions) =>
      Effect.gen(function* () {
        const ctx = context(runtimeArgs, opts)
        const result: MCPResult = yield* requestMcpTool(runtimeArgs, opts, ctx)
        const { textParts, attachments } = collectContent(result.content)
        const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...result.metadata,
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }
        const output = {
          title: "",
          metadata,
          output: truncated.content,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: PartID.ascending(),
            sessionID: ctx.sessionID,
            messageID: input.processor.message.id,
          })),
          content: result.content,
        }
        if (opts.abortSignal?.aborted) yield* input.processor.completeToolCall(opts.toolCallId, output)
        return output
      })

    item.execute = (args, opts) => {
      const hook = hookContext(key, opts.toolCallId)
      return run.promise(
        runToolHookLifecycle({
          plugin,
          context: hook,
          args,
          execute: (runtimeArgs) => executeMcpTool(runtimeArgs, opts),
        }).pipe(Effect.map(({ output }) => output)),
      )
    }
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"
