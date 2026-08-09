import { Schema } from "effect"
import {
  CONTROL_PROTOCOL_V1,
  GetAlgorithmRequest,
  GetAlgorithmResponse,
  HandshakeRequest,
  HandshakeResponse,
  type LegalActionId,
  type LifecycleGuardId,
  LegalNextActionsRequest,
  LegalNextActionsResponse,
  type LifecycleState,
  ListAlgorithmsRequest,
  ListAlgorithmsResponse,
  RequestFrame,
  ResponseFrame,
  type TenantId,
} from "./v1"

export type WireSchema = Schema.Codec<any, any>
export type SemanticValidator<Request, Response> = (request: Request, response: Response) => string | undefined

export type OperationAuthorization =
  | { readonly kind: "public" }
  | {
      readonly kind: "authenticated"
      readonly requiredScopes: readonly string[]
      readonly tenantId: (request: unknown) => TenantId
    }

export interface OperationDefinition<Name extends string, Request extends WireSchema, Response extends WireSchema> {
  readonly name: Name
  readonly protocolVersion: typeof CONTROL_PROTOCOL_V1
  readonly summary: string
  readonly request: Request
  readonly response: Response
  readonly authorization: OperationAuthorization
  readonly validateResponse: SemanticValidator<unknown, unknown>
}

function defineOperation<const Name extends string, Request extends WireSchema, Response extends WireSchema>(
  definition: Omit<OperationDefinition<Name, Request, Response>, "authorization" | "validateResponse"> & {
    readonly authorization:
      | { readonly kind: "public" }
      | {
          readonly kind: "authenticated"
          readonly requiredScopes: readonly string[]
          readonly tenantId: (request: Schema.Schema.Type<Request>) => TenantId
        }
    readonly validateResponse: SemanticValidator<Schema.Schema.Type<Request>, Schema.Schema.Type<Response>>
  },
): OperationDefinition<Name, Request, Response> {
  const decodeRequest = Schema.decodeUnknownSync(definition.request, {
    errors: "all",
    onExcessProperty: "error",
  })
  const decodeResponse = Schema.decodeUnknownSync(definition.response, {
    errors: "all",
    onExcessProperty: "error",
  })
  let authorization: OperationAuthorization
  if (definition.authorization.kind === "public") {
    authorization = definition.authorization
  } else {
    const authenticated = definition.authorization
    authorization = {
      ...authenticated,
      tenantId: (request) => authenticated.tenantId(decodeRequest(request)),
    }
  }
  return {
    ...definition,
    authorization,
    validateResponse: (request, response) =>
      definition.validateResponse(decodeRequest(request), decodeResponse(response)),
  }
}

function sameKey(
  left: { readonly tenantId: string; readonly algorithmId: string },
  right: { readonly tenantId: string; readonly algorithmId: string },
) {
  return left.tenantId === right.tenantId && left.algorithmId === right.algorithmId
}

type WireLifecycleTransition = Readonly<{
  from: LifecycleState
  to: LifecycleState
  action: LegalActionId
  requiredEvidence: readonly LifecycleGuardId[]
}>

export const controlV1LifecycleTransitions = [
  { from: "draft", to: "validated", action: "validate", requiredEvidence: ["validation.passed"] },
  {
    from: "validated",
    to: "backtested",
    action: "record_strict_backtest",
    requiredEvidence: ["backtest.strict_verified"],
  },
  { from: "backtested", to: "qualified", action: "qualify", requiredEvidence: ["qualification.passed"] },
  {
    from: "qualified",
    to: "paper_approved",
    action: "approve_paper",
    requiredEvidence: ["paper.approval_granted"],
  },
  {
    from: "paper_approved",
    to: "paper_running",
    action: "start_paper",
    requiredEvidence: ["paper.activation_receipt_verified"],
  },
  {
    from: "paper_running",
    to: "live_eligible",
    action: "establish_live_eligibility",
    requiredEvidence: [
      "paper.minimum_ledger_duration_met",
      "paper.drift_within_bounds",
      "runtime.pinned_image_attested",
    ],
  },
  { from: "live_eligible", to: "live_running", action: "start_live", requiredEvidence: ["live.gate_passed"] },
  {
    from: "backtested",
    to: "invalidated",
    action: "invalidate",
    requiredEvidence: ["backtest.evidence_revoked"],
  },
  {
    from: "qualified",
    to: "superseded",
    action: "supersede",
    requiredEvidence: ["version.newer_qualified"],
  },
  { from: "live_running", to: "retired", action: "retire", requiredEvidence: ["deployment.stopped"] },
] as const satisfies readonly WireLifecycleTransition[]

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const readAuthorization = <Request>(tenantId: (request: Request) => TenantId) =>
  ({ kind: "authenticated", requiredScopes: ["algorithm:read"], tenantId }) as const

export const operationDefinitions = {
  "protocol.handshake": defineOperation({
    name: "protocol.handshake",
    protocolVersion: CONTROL_PROTOCOL_V1,
    summary: "Confirm fixed Control API V1 compatibility.",
    request: HandshakeRequest,
    response: HandshakeResponse,
    authorization: { kind: "public" },
    validateResponse: () => undefined,
  }),
  "algorithm.list": defineOperation({
    name: "algorithm.list",
    protocolVersion: CONTROL_PROTOCOL_V1,
    summary: "List authenticated-tenant algorithm summaries.",
    request: ListAlgorithmsRequest,
    response: ListAlgorithmsResponse,
    authorization: readAuthorization((request: Schema.Schema.Type<typeof ListAlgorithmsRequest>) => request.tenantId),
    validateResponse: (request, response) =>
      response.items.every((item) => item.key.tenantId === request.tenantId)
        ? undefined
        : "algorithm.list returned an item outside the requested tenant",
  }),
  "algorithm.get": defineOperation({
    name: "algorithm.get",
    protocolVersion: CONTROL_PROTOCOL_V1,
    summary: "Get one tenant-scoped exact algorithm-version projection.",
    request: GetAlgorithmRequest,
    response: GetAlgorithmResponse,
    authorization: readAuthorization(
      (request: Schema.Schema.Type<typeof GetAlgorithmRequest>) => request.ref.key.tenantId,
    ),
    validateResponse: (request, response) => {
      if (!sameKey(response.algorithm.key, request.ref.key)) return "algorithm.get returned a different algorithm key"
      if (response.version.version !== request.ref.version) return "algorithm.get returned a different exact version"
      if (response.algorithm.latestVersion < request.ref.version) {
        return "algorithm.get returned a latest version older than the requested version"
      }
      return undefined
    },
  }),
  "algorithm.legal-next-actions": defineOperation({
    name: "algorithm.legal-next-actions",
    protocolVersion: CONTROL_PROTOCOL_V1,
    summary: "Project legal lifecycle transitions for one exact algorithm version.",
    request: LegalNextActionsRequest,
    response: LegalNextActionsResponse,
    authorization: readAuthorization(
      (request: Schema.Schema.Type<typeof LegalNextActionsRequest>) => request.ref.key.tenantId,
    ),
    validateResponse: (request, response) => {
      if (!sameKey(response.ref.key, request.ref.key) || response.ref.version !== request.ref.version) {
        return "algorithm.legal-next-actions returned a different exact reference"
      }
      for (const action of response.actions) {
        const transition = controlV1LifecycleTransitions.find(
          (candidate) =>
            candidate.from === response.state && candidate.action === action.id && candidate.to === action.to,
        )
        if (!transition) {
          return `illegal lifecycle projection ${response.state}/${action.id}/${action.to}`
        }
        if (!sameOrderedValues(action.requiredEvidence, transition.requiredEvidence)) {
          return `incorrect lifecycle evidence projection ${response.state}/${action.id}`
        }
      }
      return undefined
    },
  }),
} as const

export const controlApiRpcBinding = {
  protocolVersion: CONTROL_PROTOCOL_V1,
  method: "POST",
  path: "/control/v1/rpc",
  request: RequestFrame,
  response: ResponseFrame,
} as const

export type OperationName = keyof typeof operationDefinitions
export type OperationRequest<Name extends OperationName> = Schema.Schema.Type<
  (typeof operationDefinitions)[Name]["request"]
>
export type OperationResponse<Name extends OperationName> = Schema.Schema.Type<
  (typeof operationDefinitions)[Name]["response"]
>

export function validateOperationResponse(
  operation: OperationName,
  request: unknown,
  response: unknown,
): string | undefined {
  const definition = operationDefinitions[operation]
  return definition.validateResponse(request, response)
}
