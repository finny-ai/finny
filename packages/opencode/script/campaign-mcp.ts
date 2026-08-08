#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const baseURL = (process.env.FINNY_SERVER_URL ?? "http://127.0.0.1:4096").replace(/\/$/, "")
const directory = process.env.FINNY_DIRECTORY ?? process.cwd()
const password = process.env.FINNY_SERVER_PASSWORD

async function request(method: string, path: string, body?: unknown) {
  const url = new URL(`${baseURL}${path}`)
  url.searchParams.set("directory", directory)
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(password ? { authorization: `Basic ${btoa(`opencode:${password}`)}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`)
  return text ? JSON.parse(text) : null
}

const object = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
})
const string = { type: "string" as const }
const number = { type: "number" as const }

const tools = [
  {
    name: "campaign_create",
    description: "Create or recover a durable Finny campaign. operationID is the idempotency key.",
    inputSchema: object(
      {
        operationID: string,
        goal: string,
        candidates: {
          type: "array",
          minItems: 1,
          items: object({ id: string, prompt: string, parentCandidateID: string }, ["id", "prompt"]),
        },
        budget: object(
          { maxSessions: number, maxTurns: number, maxTokens: number, maxCost: number, maxWallClockMs: number },
          ["maxSessions", "maxTurns", "maxTokens", "maxCost", "maxWallClockMs"],
        ),
        stop: object({ maxRounds: number, targetSharpe: number, maxDrawdown: number }, ["maxRounds"]),
        agent: string,
      },
      ["operationID", "goal", "candidates", "budget", "stop"],
    ),
  },
  {
    name: "campaign_start",
    description: "Launch one candidate in its isolated Finny root session.",
    inputSchema: object({ campaignID: string, candidateID: string, operationID: string }, [
      "campaignID",
      "candidateID",
      "operationID",
    ]),
  },
  {
    name: "campaign_continue",
    description: "Send a targeted follow-up to exactly one idle campaign session.",
    inputSchema: object({ campaignID: string, candidateID: string, operationID: string, prompt: string }, [
      "campaignID",
      "candidateID",
      "operationID",
      "prompt",
    ]),
  },
  {
    name: "campaign_observe",
    description: "Read cursor-based events, optionally waiting up to 30 seconds.",
    inputSchema: object({ campaignID: string, after: number, timeoutMs: number }, ["campaignID"]),
  },
  {
    name: "campaign_abort",
    description: "Abort one exact candidate session or the whole campaign.",
    inputSchema: object({ campaignID: string, operationID: string, candidateID: string }, [
      "campaignID",
      "operationID",
    ]),
  },
  {
    name: "campaign_record_artifact",
    description: "Attach an existing persisted Crucible manifest to a candidate lineage.",
    inputSchema: object({ campaignID: string, operationID: string, candidateID: string, manifestID: string }, [
      "campaignID",
      "operationID",
      "candidateID",
      "manifestID",
    ]),
  },
  {
    name: "campaign_compare",
    description: "Deterministically rank Crucible results that share identical request assumptions.",
    inputSchema: object({ campaignID: string }, ["campaignID"]),
  },
  {
    name: "campaign_advance",
    description: "Advance one bounded improvement-loop step while enforcing budgets and stopping rules.",
    inputSchema: object({ campaignID: string, operationID: string, improvementPrompt: string }, [
      "campaignID",
      "operationID",
    ]),
  },
]

const server = new Server({ name: "finny-campaign-control-plane", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = (params.arguments ?? {}) as Record<string, unknown>
  const campaignID = String(args.campaignID ?? "")
  let value: unknown
  switch (params.name) {
    case "campaign_create":
      value = await request("POST", "/experimental/campaign", args)
      break
    case "campaign_start":
      value = await request(
        "POST",
        `/experimental/campaign/${campaignID}/candidate/${String(args.candidateID)}/start`,
        {
          operationID: args.operationID,
        },
      )
      break
    case "campaign_continue":
      value = await request("POST", `/experimental/campaign/${campaignID}/continue`, {
        operationID: args.operationID,
        candidateID: args.candidateID,
        prompt: args.prompt,
      })
      break
    case "campaign_observe": {
      const query = new URLSearchParams()
      if (args.after !== undefined) query.set("after", String(args.after))
      if (args.timeoutMs !== undefined) query.set("timeoutMs", String(args.timeoutMs))
      value = await request("GET", `/experimental/campaign/${campaignID}/wait?${query}`)
      break
    }
    case "campaign_abort":
      value = await request("POST", `/experimental/campaign/${campaignID}/abort`, {
        operationID: args.operationID,
        ...(args.candidateID === undefined ? {} : { candidateID: args.candidateID }),
      })
      break
    case "campaign_record_artifact":
      value = await request("POST", `/experimental/campaign/${campaignID}/artifact`, {
        operationID: args.operationID,
        candidateID: args.candidateID,
        manifestID: args.manifestID,
      })
      break
    case "campaign_compare":
      value = await request("GET", `/experimental/campaign/${campaignID}/comparison`)
      break
    case "campaign_advance":
      value = await request("POST", `/experimental/campaign/${campaignID}/advance`, {
        operationID: args.operationID,
        ...(args.improvementPrompt === undefined ? {} : { improvementPrompt: args.improvementPrompt }),
      })
      break
    default:
      throw new Error(`Unknown tool: ${params.name}`)
  }
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
})

await server.connect(new StdioServerTransport())
