export * as PermissionV1 from "./permission"

import { Schema } from "effect"
import { ProjectV2 } from "../project"
import { withStatics } from "../schema"
import { SessionSchema } from "../session/schema"
import { Identifier } from "../util/identifier"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionID"),
  withStatics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "per_" + Identifier.ascending()) })),
)
export type ID = typeof ID.Type

export const Action = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "PermissionAction" })
export type Action = typeof Action.Type

export const Rule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
}).annotate({ identifier: "PermissionRule" })
export type Rule = typeof Rule.Type

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "PermissionRuleset" })
export type Ruleset = typeof Ruleset.Type

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionSchema.ID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.Struct({
    messageID: Schema.String,
    callID: Schema.String,
  }).pipe(Schema.optional),
}).annotate({ identifier: "PermissionRequest" })
export type Request = typeof Request.Type

export const Reply = Schema.Literals(["once", "always", "reject"])
export type Reply = typeof Reply.Type

export const ReplyBody = Schema.Struct({
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionReplyBody" })
export type ReplyBody = typeof ReplyBody.Type

export const Approval = Schema.Struct({
  projectID: ProjectV2.ID,
  patterns: Schema.Array(Schema.String),
}).annotate({ identifier: "PermissionApproval" })
export type Approval = typeof Approval.Type

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: ID.pipe(Schema.optional),
  ruleset: Ruleset,
}).annotate({ identifier: "PermissionAskInput" })
export type AskInput = typeof AskInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  ...ReplyBody.fields,
}).annotate({ identifier: "PermissionReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

function deniedPermissionNames(ruleset: unknown): string[] {
  if (!Array.isArray(ruleset)) return []
  return Array.from(
    new Set(
      ruleset
        .map((rule) => rule?.action === "deny" && typeof rule?.permission === "string" ? rule.permission : undefined)
        .filter((permission): permission is string => Boolean(permission)),
    ),
  )
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    const permissions = deniedPermissionNames(this.ruleset)
    const detail = permissions.length === 1
      ? `permission "${permissions[0]}" is denied`
      : permissions.length > 1
        ? `permissions ${permissions.map((permission) => `"${permission}"`).join(", ")} are denied`
        : "a matching permission is denied"
    return `This tool call was denied by the user's permission rules (${detail}). Do not retry the same call; choose an allowed approach.`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError
