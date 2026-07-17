import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { createLocalSdk } from "../local-sdk"
import { FormatError, FormatUnknownError } from "../error"

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

function formatSdkError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

function isStringMatrix(value: unknown): value is string[][] {
  if (!Array.isArray(value)) return false
  return value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))
}

function parseAnswers(raw: string): string[][] {
  try {
    const parsed = JSON.parse(raw)
    if (!isStringMatrix(parsed)) throw new Error("answers must be a JSON array of string arrays")
    return parsed
  } catch (error) {
    throw new Error(`Invalid answers JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function maybeMessage(message: string | undefined) {
  return message ? { message } : {}
}

function listPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") return Object.values(value)
  return []
}

const replyMode = {
  once: "once",
  always: "always",
  reject: "reject",
} as const

function listQuestions() {
  return Effect.gen(function* () {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() => sdk.question.list())
    if (result.error) return yield* fail(formatSdkError(result.error))
    return listPayload(result.data)
  })
}

function listPermissions() {
  return Effect.gen(function* () {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() => sdk.permission.list())
    if (result.error) return yield* fail(formatSdkError(result.error))
    return listPayload(result.data)
  })
}

function replyQuestion(requestID: string, answers: string[][]) {
  return Effect.gen(function* () {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() => sdk.question.reply({ requestID, answers }))
    if (result.error) return yield* fail(formatSdkError(result.error))
    return { ok: true, requestID, kind: "question" as const }
  })
}

function replyPermission(requestID: string, reply: (typeof replyMode)[keyof typeof replyMode], message?: string) {
  return Effect.gen(function* () {
    const sdk = createLocalSdk(process.cwd())
    const result = yield* Effect.promise(() => sdk.permission.reply({ requestID, reply, ...maybeMessage(message) }))
    if (result.error) return yield* fail(formatSdkError(result.error))
    return { ok: true, requestID, reply }
  })
}

export const InboxCommand = cmd({
  command: "inbox",
  describe: "manage pending questions and permissions",
  builder: (yargs: Argv) =>
    yargs
      .command(InboxListCommand)
      .command(InboxQuestionsCommand)
      .command(InboxPermissionsCommand)
      .command(InboxAnswerCommand)
      .command(InboxApproveCommand)
      .command(InboxDenyCommand)
      .demandCommand(),
  async handler() {},
})

const InboxListCommand = effectCmd({
  command: "list",
  describe: "list all pending inbox items",
  handler: Effect.fn("Cli.inbox.list")(function* () {
    const [questions, permissions] = yield* Effect.all([listQuestions(), listPermissions()])
    print({ questions, permissions })
  }),
})

const InboxQuestionsCommand = effectCmd({
  command: "questions",
  describe: "list pending questions",
  handler: Effect.fn("Cli.inbox.questions")(function* () {
    print(yield* listQuestions())
  }),
})

const InboxPermissionsCommand = effectCmd({
  command: "permissions",
  describe: "list pending permissions",
  handler: Effect.fn("Cli.inbox.permissions")(function* () {
    print(yield* listPermissions())
  }),
})

const InboxAnswerCommand = effectCmd({
  command: "answer <requestID>",
  describe: "answer a pending question with JSON answers",
  builder: (yargs) =>
    yargs
      .positional("requestID", {
        type: "string",
        demandOption: true,
        describe: "question request ID",
      })
      .option("answers", {
        type: "string",
        demandOption: true,
        describe: 'JSON array of string arrays, e.g. [["1h"],["risk-off"]]',
      }),
  handler: Effect.fn("Cli.inbox.answer")(function* (args) {
    print(yield* replyQuestion(args.requestID, parseAnswers(args.answers)))
  }),
})

const InboxApproveCommand = effectCmd({
  command: "approve <requestID>",
  describe: "approve a pending permission request",
  builder: (yargs) =>
    yargs
      .positional("requestID", {
        type: "string",
        demandOption: true,
        describe: "permission request ID",
      })
      .option("message", {
        type: "string",
        describe: "optional approval message",
      })
      .option("always", {
        type: "boolean",
        default: false,
        describe: "persist approval beyond this one request",
      }),
  handler: Effect.fn("Cli.inbox.approve")(function* (args) {
    const reply = args.always ? replyMode.always : replyMode.once
    print(yield* replyPermission(args.requestID, reply, args.message))
  }),
})

const InboxDenyCommand = effectCmd({
  command: "deny <requestID>",
  describe: "deny a pending permission request",
  builder: (yargs) =>
    yargs
      .positional("requestID", {
        type: "string",
        demandOption: true,
        describe: "permission request ID",
      })
      .option("message", {
        type: "string",
        describe: "optional denial message",
      }),
  handler: Effect.fn("Cli.inbox.deny")(function* (args) {
    print(yield* replyPermission(args.requestID, replyMode.reject, args.message))
  }),
})
