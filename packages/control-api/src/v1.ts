import { Schema } from "effect"

export const CONTROL_PROTOCOL_V1 = "1.0" as const
export const CONTROL_PROTOCOL_VERSIONS = [CONTROL_PROTOCOL_V1] as const

const NoAsciiControls = Schema.makeFilter<string>((value) =>
  /[\u0000-\u001f\u007f]/.test(value) ? "must not contain ASCII control characters" : undefined,
)
const ValidUnicode = Schema.makeFilter<string>((value) => {
  try {
    encodeURIComponent(value)
    return undefined
  } catch {
    return "must contain valid Unicode"
  }
})
const BoundedIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isTrimmed(),
  NoAsciiControls,
  ValidUnicode,
)
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))

export const ProtocolVersion = BoundedIdentifier.annotate({
  identifier: "ControlProtocolVersion",
  description: "The fixed wire-protocol version carried by a Control API frame.",
})
export type ProtocolVersion = Schema.Schema.Type<typeof ProtocolVersion>

export const TenantId = BoundedIdentifier.annotate({
  identifier: "TenantId",
  description: "Authenticated tenant boundary. Local installations use the literal local.",
})
export type TenantId = Schema.Schema.Type<typeof TenantId>

export const AlgorithmId = BoundedIdentifier.annotate({
  identifier: "AlgorithmId",
  description: "Opaque, stable algorithm identity. It is not a display slug.",
})
export type AlgorithmId = Schema.Schema.Type<typeof AlgorithmId>

export const AlgorithmSlug = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*$/),
).annotate({
  identifier: "AlgorithmSlug",
  description: "Human-readable tenant-scoped alias. It is not a stable identity or lineage key.",
})
export type AlgorithmSlug = Schema.Schema.Type<typeof AlgorithmSlug>

export const AlgorithmVersion = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).annotate({
  identifier: "AlgorithmVersion",
  description: "One-based immutable algorithm version number.",
})
export type AlgorithmVersion = Schema.Schema.Type<typeof AlgorithmVersion>

function isUtcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}

export const UtcTimestamp = Schema.String.check(
  Schema.makeFilter<string>((value) => (isUtcTimestamp(value) ? undefined : "must be a valid RFC 3339 UTC timestamp")),
).annotate({
  identifier: "UtcTimestamp",
  description: "Semantically valid RFC 3339 UTC timestamp ending in Z.",
})
export type UtcTimestamp = Schema.Schema.Type<typeof UtcTimestamp>

export const ContentDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)).annotate({
  identifier: "ContentDigest",
  description: "Canonical sha256:<lowercase-hex> digest of an immutable version package.",
})
export type ContentDigest = Schema.Schema.Type<typeof ContentDigest>

export const CONTROL_V1_LIFECYCLE_STATES = [
  "draft",
  "validated",
  "backtested",
  "qualified",
  "paper_approved",
  "paper_running",
  "live_eligible",
  "live_running",
  "invalidated",
  "superseded",
  "retired",
] as const

export const LifecycleState = Schema.Literals(CONTROL_V1_LIFECYCLE_STATES).annotate({
  identifier: "AlgorithmLifecycleState",
  description: "Observed lifecycle state of one exact algorithm version.",
})
export type LifecycleState = Schema.Schema.Type<typeof LifecycleState>

export const AlgorithmKey = Schema.Struct({
  tenantId: TenantId,
  algorithmId: AlgorithmId,
}).annotate({
  identifier: "AlgorithmKey",
  description: "Canonical stable algorithm identity within a tenant.",
})
export type AlgorithmKey = Schema.Schema.Type<typeof AlgorithmKey>

export const ExactAlgorithmVersionRef = Schema.Struct({
  key: AlgorithmKey,
  version: AlgorithmVersion,
}).annotate({
  identifier: "ExactAlgorithmVersionRef",
  description: "Stable tenant-scoped reference to one immutable algorithm version.",
})
export type ExactAlgorithmVersionRef = Schema.Schema.Type<typeof ExactAlgorithmVersionRef>

export const AlgorithmSummary = Schema.Struct({
  key: AlgorithmKey,
  slug: AlgorithmSlug,
  displayName: NonEmptyString,
  latestVersion: AlgorithmVersion,
  updatedAt: UtcTimestamp,
}).annotate({ identifier: "AlgorithmSummary" })
export type AlgorithmSummary = Schema.Schema.Type<typeof AlgorithmSummary>

export const AlgorithmVersionDetail = Schema.Struct({
  version: AlgorithmVersion,
  state: LifecycleState,
  contentDigest: ContentDigest,
  createdAt: UtcTimestamp,
  mission: Schema.String,
}).annotate({
  identifier: "AlgorithmVersionDetail",
  description: "Read-only detail for one exact version; identity is carried once by its containing algorithm.",
})
export type AlgorithmVersionDetail = Schema.Schema.Type<typeof AlgorithmVersionDetail>

export const CONTROL_V1_LIFECYCLE_ACTIONS = [
  "validate",
  "record_strict_backtest",
  "qualify",
  "approve_paper",
  "start_paper",
  "establish_live_eligibility",
  "start_live",
  "invalidate",
  "supersede",
  "retire",
] as const

export const LegalActionId = Schema.Literals(CONTROL_V1_LIFECYCLE_ACTIONS).annotate({
  identifier: "AlgorithmLegalActionId",
})
export type LegalActionId = Schema.Schema.Type<typeof LegalActionId>

export const CONTROL_V1_LIFECYCLE_GUARDS = [
  "validation.passed",
  "backtest.strict_verified",
  "qualification.passed",
  "paper.approval_granted",
  "paper.activation_receipt_verified",
  "paper.minimum_ledger_duration_met",
  "paper.drift_within_bounds",
  "runtime.pinned_image_attested",
  "live.gate_passed",
  "backtest.evidence_revoked",
  "version.newer_qualified",
  "deployment.stopped",
] as const

export const LifecycleGuardId = Schema.Literals(CONTROL_V1_LIFECYCLE_GUARDS).annotate({
  identifier: "AlgorithmLifecycleGuardId",
})
export type LifecycleGuardId = Schema.Schema.Type<typeof LifecycleGuardId>

export const LegalNextAction = Schema.Struct({
  id: LegalActionId,
  to: LifecycleState,
  requiredEvidence: Schema.Array(LifecycleGuardId),
}).annotate({
  identifier: "AlgorithmLegalNextAction",
  description: "A currently legal transition projected from the response state.",
})
export type LegalNextAction = Schema.Schema.Type<typeof LegalNextAction>

export const ClientDescriptor = Schema.Struct({
  name: BoundedIdentifier,
  version: BoundedIdentifier,
}).annotate({ identifier: "ControlApiClientDescriptor" })

export const ServerDescriptor = Schema.Struct({
  name: BoundedIdentifier,
  version: BoundedIdentifier,
}).annotate({ identifier: "ControlApiServerDescriptor" })
export type ServerDescriptor = Schema.Schema.Type<typeof ServerDescriptor>

export const AuthenticatedRequestContext = Schema.Struct({
  tenantId: TenantId,
  actor: BoundedIdentifier,
  scopes: Schema.Array(BoundedIdentifier),
  requestId: BoundedIdentifier,
}).annotate({ identifier: "ControlApiAuthenticatedRequestContext" })
export type AuthenticatedRequestContext = Schema.Schema.Type<typeof AuthenticatedRequestContext>

export const HandshakeRequest = Schema.Struct({
  client: ClientDescriptor,
}).annotate({ identifier: "ControlApiV1HandshakeRequest" })
export type HandshakeRequest = Schema.Schema.Type<typeof HandshakeRequest>

export const HandshakeResponse = Schema.Struct({
  server: ServerDescriptor,
  protocolVersion: Schema.Literal(CONTROL_PROTOCOL_V1),
}).annotate({ identifier: "ControlApiV1HandshakeResponse" })
export type HandshakeResponse = Schema.Schema.Type<typeof HandshakeResponse>

export const ListAlgorithmsRequest = Schema.Struct({
  tenantId: TenantId,
  cursor: NonEmptyString.pipe(Schema.optional),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 })).pipe(Schema.optional),
}).annotate({ identifier: "ControlApiV1ListAlgorithmsRequest" })
export type ListAlgorithmsRequest = Schema.Schema.Type<typeof ListAlgorithmsRequest>

export const ListAlgorithmsResponse = Schema.Struct({
  items: Schema.Array(AlgorithmSummary),
  nextCursor: NonEmptyString.pipe(Schema.optional),
}).annotate({ identifier: "ControlApiV1ListAlgorithmsResponse" })
export type ListAlgorithmsResponse = Schema.Schema.Type<typeof ListAlgorithmsResponse>

export const GetAlgorithmRequest = Schema.Struct({
  ref: ExactAlgorithmVersionRef,
}).annotate({ identifier: "ControlApiV1GetAlgorithmRequest" })
export type GetAlgorithmRequest = Schema.Schema.Type<typeof GetAlgorithmRequest>

export const GetAlgorithmResponse = Schema.Struct({
  algorithm: AlgorithmSummary,
  version: AlgorithmVersionDetail,
}).annotate({ identifier: "ControlApiV1GetAlgorithmResponse" })
export type GetAlgorithmResponse = Schema.Schema.Type<typeof GetAlgorithmResponse>

export const LegalNextActionsRequest = Schema.Struct({
  ref: ExactAlgorithmVersionRef,
}).annotate({ identifier: "ControlApiV1LegalNextActionsRequest" })
export type LegalNextActionsRequest = Schema.Schema.Type<typeof LegalNextActionsRequest>

export const LegalNextActionsResponse = Schema.Struct({
  ref: ExactAlgorithmVersionRef,
  state: LifecycleState,
  actions: Schema.Array(LegalNextAction),
}).annotate({ identifier: "ControlApiV1LegalNextActionsResponse" })
export type LegalNextActionsResponse = Schema.Schema.Type<typeof LegalNextActionsResponse>

export const ValidationProtocolError = Schema.Struct({
  code: Schema.Literal("validation_error"),
  message: NonEmptyString,
  phase: Schema.Literals(["frame", "request", "response"]),
  operation: NonEmptyString.pipe(Schema.optional),
}).annotate({ identifier: "ControlApiValidationError" })

export const UnsupportedProtocolVersionError = Schema.Struct({
  code: Schema.Literal("unsupported_protocol_version"),
  message: NonEmptyString,
  supportedVersions: Schema.Array(ProtocolVersion).check(Schema.isMinLength(1)),
  requestedVersions: Schema.Array(ProtocolVersion).check(Schema.isMinLength(1)),
}).annotate({ identifier: "ControlApiUnsupportedProtocolVersionError" })

export const UnknownOperationError = Schema.Struct({
  code: Schema.Literal("unknown_operation"),
  message: NonEmptyString,
  operation: NonEmptyString,
}).annotate({ identifier: "ControlApiUnknownOperationError" })

export const ResourceNotFoundError = Schema.Struct({
  code: Schema.Literal("resource_not_found"),
  message: NonEmptyString,
  resource: NonEmptyString,
}).annotate({ identifier: "ControlApiResourceNotFoundError" })

export const ForbiddenProtocolError = Schema.Struct({
  code: Schema.Literal("forbidden"),
  message: NonEmptyString,
  requiredScopes: Schema.Array(NonEmptyString),
}).annotate({ identifier: "ControlApiForbiddenError" })

export const InternalProtocolError = Schema.Struct({
  code: Schema.Literal("internal_error"),
  message: NonEmptyString,
}).annotate({ identifier: "ControlApiInternalError" })

export const ProtocolError = Schema.Union([
  ValidationProtocolError,
  UnsupportedProtocolVersionError,
  UnknownOperationError,
  ResourceNotFoundError,
  ForbiddenProtocolError,
  InternalProtocolError,
]).annotate({ identifier: "ControlApiProtocolError" })
export type ProtocolError = Schema.Schema.Type<typeof ProtocolError>

const OperationId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]*$/))

export const RequestFrame = Schema.Struct({
  protocolVersion: ProtocolVersion,
  operation: OperationId,
  request: Schema.Json,
}).annotate({ identifier: "ControlApiRequestFrame" })
export type RequestFrame = Schema.Schema.Type<typeof RequestFrame>

export const SuccessResponseFrame = Schema.Struct({
  protocolVersion: Schema.Literal(CONTROL_PROTOCOL_V1),
  operation: OperationId,
  ok: Schema.Literal(true),
  response: Schema.Json,
}).annotate({ identifier: "ControlApiSuccessResponseFrame" })

export const ErrorResponseFrame = Schema.Struct({
  protocolVersion: Schema.Literal(CONTROL_PROTOCOL_V1),
  operation: OperationId,
  ok: Schema.Literal(false),
  error: ProtocolError,
}).annotate({ identifier: "ControlApiErrorResponseFrame" })

export const ResponseFrame = Schema.Union([SuccessResponseFrame, ErrorResponseFrame]).annotate({
  identifier: "ControlApiResponseFrame",
})
export type ResponseFrame = Schema.Schema.Type<typeof ResponseFrame>
