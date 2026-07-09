import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import { createLocalSdk } from "../local-sdk"
import { Agent } from "@/agent/agent"
import { FormatError, FormatUnknownError } from "../error"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"

type ModelInput = Parameters<OpencodeClient["session"]["prompt"]>[0]["model"]

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function formatSdkError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

export function sessionMessagesPage(result: {
  data?: unknown[]
  response: { headers: Pick<Headers, "get"> }
}) {
  return {
    messages: result.data ?? [],
    nextCursor: result.response.headers.get("X-Next-Cursor"),
  }
}

function parseModel(value: string | undefined): ModelInput | undefined {
  if (!value) return undefined
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID.length || !modelID.length) {
    throw new Error(`Invalid model ${value}. Model must be in the format "provider/model".`)
  }
  return { providerID, modelID } as ModelInput
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs
      .command(SessionListCommand)
      .command(SessionCurrentCommand)
      .command(SessionShowCommand)
      .command(SessionMessagesCommand)
      .command(SessionCreateCommand)
      .command(SessionSendCommand)
      .command(SessionModesCommand)
      .command(SessionModeCommand)
      .command(SessionAbortCommand)
      .command(SessionDeleteCommand)
      .demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionAbortCommand = effectCmd({
  command: "abort <sessionID>",
  describe: "abort a running session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to abort",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.abort")(function* (args) {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() => sdk.session.abort({ sessionID: args.sessionID }))
    if (result.error) return yield* fail(formatSdkError(result.error))
    print({ ok: true, sessionID: args.sessionID })
  }),
})

export const SessionCreateCommand = effectCmd({
  command: "create",
  describe: "create a new session",
  builder: (yargs) =>
    yargs.option("title", {
      type: "string",
      describe: "optional session title",
    }),
  handler: Effect.fn("Cli.session.create")(function* (args) {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() => sdk.session.create(args.title ? { title: args.title } : {}))
    if (result.error) return yield* fail(formatSdkError(result.error))
    print(result.data)
  }),
})

export const SessionCurrentCommand = effectCmd({
  command: "current",
  describe: "show the most recently updated root session",
  handler: Effect.fn("Cli.session.current")(function* () {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() => sdk.session.list({ roots: true, limit: 1 }))
    if (result.error) return yield* fail(formatSdkError(result.error))
    const session = result.data?.[0]
    if (!session) return yield* fail("No sessions found")
    print(session)
  }),
})

export const SessionShowCommand = effectCmd({
  command: "show <sessionID>",
  describe: "show session metadata and current status",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .option("include-messages", {
        type: "boolean",
        default: false,
        describe: "include session messages inline",
      }),
  handler: Effect.fn("Cli.session.show")(function* (args) {
    const sdk = createLocalSdk(process.cwd())
    const includeMessages = Boolean(args["include-messages"])
    const [sessionResult, statusResult, messagesResult] = yield* Effect.all([
      Effect.promise(() => sdk.session.get({ sessionID: args.sessionID })),
      Effect.promise(() => sdk.session.status()),
      includeMessages
        ? Effect.promise(() => sdk.session.messages({ sessionID: args.sessionID }))
        : Effect.succeed({ data: undefined, error: undefined } as const),
    ])
    if (sessionResult.error) return yield* fail(formatSdkError(sessionResult.error))
    if (statusResult.error) return yield* fail(formatSdkError(statusResult.error))
    if (messagesResult.error) return yield* fail(formatSdkError(messagesResult.error))
    print({
      session: sessionResult.data,
      status: statusResult.data?.[args.sessionID] ?? null,
      ...(includeMessages ? { messages: messagesResult.data ?? [] } : {}),
    })
  }),
})

export const SessionMessagesCommand = effectCmd({
  command: "messages <sessionID>",
  describe: "list messages for a session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .option("limit", {
        type: "number",
        describe: "max messages to return",
      })
      .option("before", {
        type: "string",
        describe: "cursor/message id for pagination",
      }),
  handler: Effect.fn("Cli.session.messages")(function* (args) {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() =>
      sdk.session.messages({
        sessionID: args.sessionID,
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        ...(args.before ? { before: args.before } : {}),
      }),
    )
    if (result.error) return yield* fail(formatSdkError(result.error))
    print(sessionMessagesPage(result))
  }),
})

export const SessionSendCommand = effectCmd({
  command: "send <sessionID> <message>",
  describe: "send a message into an existing session",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .positional("message", {
        describe: "message text",
        type: "string",
        demandOption: true,
      })
      .option("mode", {
        type: "string",
        default: "build",
        describe: "agent mode to run the prompt under",
      })
      .option("no-reply", {
        type: "boolean",
        default: false,
        describe: "queue the prompt without waiting for a model reply",
      })
      .option("model", {
        type: "string",
        describe: "optional provider/model override",
      }),
  handler: Effect.fn("Cli.session.send")(function* (args) {
    try {
      const sdk = createLocalSdk(process.cwd())
      const result = yield* Effect.promise(() =>
        sdk.session.prompt({
          sessionID: args.sessionID,
          agent: args.mode ?? "build",
          parts: [{ type: "text", text: args.message }],
          noReply: Boolean(args["no-reply"]),
          ...(args.model ? { model: parseModel(args.model) } : {}),
        }),
      )
      if (result.error) return yield* fail(formatSdkError(result.error))
      print(result.data)
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error))
    }
  }),
})

export const SessionModesCommand = effectCmd({
  command: "modes",
  describe: "list available session modes/agents",
  handler: Effect.fn("Cli.session.modes")(function* () {
    const agents = yield* Agent.Service.use((svc) => svc.list())
    print(
      agents.map((agent) => ({
        name: agent.name,
        description: agent.description,
        hidden: agent.hidden,
        mode: agent.mode,
      })),
    )
  }),
})

export const SessionModeCommand = effectCmd({
  command: "mode <sessionID> <mode> <message>",
  describe: "send a message using an explicit mode/agent",
  builder: (yargs) =>
    yargs
      .positional("sessionID", {
        describe: "session ID",
        type: "string",
        demandOption: true,
      })
      .positional("mode", {
        describe: "mode/agent name",
        type: "string",
        demandOption: true,
      })
      .positional("message", {
        describe: "message text",
        type: "string",
        demandOption: true,
      })
      .option("no-reply", {
        type: "boolean",
        default: false,
        describe: "queue the prompt without waiting for a model reply",
      })
      .option("model", {
        type: "string",
        describe: "optional provider/model override",
      }),
  handler: Effect.fn("Cli.session.mode")(function* (args) {
    try {
      const sdk = createLocalSdk(process.cwd())
      const result = yield* Effect.promise(() =>
        sdk.session.prompt({
          sessionID: args.sessionID,
          agent: args.mode,
          parts: [{ type: "text", text: args.message }],
          noReply: Boolean(args["no-reply"]),
          ...(args.model ? { model: parseModel(args.model) } : {}),
        }),
      )
      if (result.error) return yield* fail(formatSdkError(result.error))
      print(result.data)
    } catch (error) {
      return yield* fail(error instanceof Error ? error.message : String(error))
    }
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const maxCount = typeof args["max-count"] === "number" ? args["max-count"] : undefined
    const format = args.format === "json" ? "json" : "table"
    const sessions = yield* Session.Service.use((svc) => svc.list({ roots: true, limit: maxCount }))

    if (sessions.length === 0) return

    const output = format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions)
    console.log(output)
  }),
})

function formatSessionInfo(session: Session.Info) {
  return {
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }
}

function formatSessionTable(sessions: Session.Info[]): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    const line = `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`
    lines.push(line)
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  return JSON.stringify(sessions.map(formatSessionInfo), null, 2)
}
