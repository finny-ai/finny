import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Effect } from "effect"
import { algoDir } from "@finny-ai/core/algo"
import { bootstrapWorkspace } from "../plugin/finny-workspace"
import { Tool } from "./tool"

const parameters = z.object({
  requestSummary: z
    .string()
    .optional()
    .describe("Concise strategy request summary. Use when the user's request is not directly available in the current turn."),
  algorithmName: z.string().optional().describe("Optional intended algorithm/workspace name, kebab-case when known."),
  symbol: z.string().optional().describe("Primary requested symbol, e.g. BTC.USD, BTC/USD, SPY."),
  symbols: z.array(z.string()).optional().describe("Requested symbol universe for multi-symbol work."),
  assetClass: z.enum(["equity", "crypto"]).optional().describe("Requested asset class."),
  interval: z.string().optional().describe("Requested bar interval, e.g. 4h, 1h, 1d."),
  duration: z.string().optional().describe("Requested backtest/data window, e.g. 1y, 6m, one year."),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  strategyIntent: z.string().optional().describe("Requested or delegated strategy intent/family, e.g. momentum or delegated."),
})

type WorkspacePrepareMetadata = {
  workspaceSlug?: string
  workspacePath?: string
  created?: boolean
  rebound?: boolean
  requestContext?: Record<string, unknown>
}

function latestUserText(messages: Tool.Context["messages"]): string {
  for (const message of [...messages].reverse()) {
    const parts = Array.isArray((message as any).parts) ? (message as any).parts : []
    const text = parts
      .filter((part: any) => part?.type === "text" && typeof part.text === "string" && !part.synthetic)
      .map((part: any) => part.text)
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

function promptFromParams(params: z.infer<typeof parameters>, fallback: string): string {
  if (params.requestSummary?.trim()) return params.requestSummary.trim()
  const fields: Array<[string, string | undefined]> = [
    ["algorithm", params.algorithmName],
    ["symbol", params.symbol],
    ["symbols", params.symbols?.join(", ")],
    ["asset class", params.assetClass],
    ["interval", params.interval],
    ["backtest window", params.duration],
    ["date window", params.startDate && params.endDate ? `${params.startDate} to ${params.endDate}` : undefined],
    ["strategy intent", params.strategyIntent],
  ]
  const lines = fields.flatMap(([label, value]) => value ? [`${label} ${value}`] : [])
  if (lines.length) return lines.join("; ")
  return fallback
}

async function readRequestContext(workspacePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspacePath, "request.json"), "utf8"))
  } catch {
    return undefined
  }
}

export const WorkspacePrepareTool = Tool.define<typeof parameters, WorkspacePrepareMetadata, never, "finny_workspace_prepare">(
  "finny_workspace_prepare",
  Effect.succeed({
    description:
      "Create or bind the session strategy workspace from request identity before evidence subagents, save, validate, or backtest. Returns the workspace slug, path, and request context; do not manually invent repo-root workspace paths.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async () => {
        await ctx.ask({
          permission: "finny_workspace_prepare",
          patterns: ["*"],
          always: ["*"],
          metadata: {},
        })

        const prompt = promptFromParams(params, latestUserText(ctx.messages))
        if (!prompt.trim()) {
          return {
            title: "Workspace prepare failed",
            output: "No request text or structured request identity was provided.",
            metadata: {},
          }
        }

        const prepared = await bootstrapWorkspace(ctx.sessionID, prompt)
        if (!prepared) {
          return {
            title: "Workspace prepare skipped",
            output: "No strategy workspace was needed for this request.",
            metadata: {},
          }
        }

        const workspacePath = prepared.dir || algoDir(prepared.slug)
        const requestContext = await readRequestContext(workspacePath)
        const output = [
          `workspace_slug: ${prepared.slug}`,
          `workspace_path: ${workspacePath}`,
          `created: ${prepared.created}`,
          `rebound: ${prepared.rebound}`,
          `mission_path: ${path.join(workspacePath, "mission.md")}`,
          `todo_path: ${path.join(workspacePath, "todo.md")}`,
          `edge_analysis_path: ${path.join(workspacePath, "edge_analysis.md")}`,
          `data_dir: ${path.join(workspacePath, "data")}`,
          requestContext ? `request_context: ${JSON.stringify(requestContext)}` : undefined,
        ].filter(Boolean).join("\n")

        return {
          title: prepared.created ? `Created workspace ${prepared.slug}` : `Using workspace ${prepared.slug}`,
          output,
          metadata: {
            workspaceSlug: prepared.slug,
            workspacePath,
            created: prepared.created,
            rebound: prepared.rebound,
            requestContext,
          },
        }
      }),
  }),
)
