import { CONTROL_PROTOCOL_V1, type HandshakeRequest, type HandshakeResponse, RequestFrame, ResponseFrame } from "./v1"
import {
  type OperationName,
  type OperationRequest,
  type OperationResponse,
  operationDefinitions,
  validateOperationResponse,
} from "./operations"
import {
  ControlApiCodecError,
  ControlApiRemoteError,
  type ControlApiTransport,
  parseJsonText,
  strictDecode,
  stringifyJsonValue,
} from "./transport"

export interface ControlApiClientOptions {
  readonly protocolVersion?: string
}

export interface ControlApiClient {
  readonly call: <Name extends OperationName>(
    operation: Name,
    request: OperationRequest<Name>,
  ) => Promise<OperationResponse<Name>>
  readonly handshake: (request: HandshakeRequest) => Promise<HandshakeResponse>
  readonly algorithms: {
    readonly list: (request: OperationRequest<"algorithm.list">) => Promise<OperationResponse<"algorithm.list">>
    readonly get: (request: OperationRequest<"algorithm.get">) => Promise<OperationResponse<"algorithm.get">>
    readonly legalNextActions: (
      request: OperationRequest<"algorithm.legal-next-actions">,
    ) => Promise<OperationResponse<"algorithm.legal-next-actions">>
  }
}

export function createControlApiClient(
  transport: ControlApiTransport,
  options: ControlApiClientOptions = {},
): ControlApiClient {
  const protocolVersion = options.protocolVersion ?? CONTROL_PROTOCOL_V1

  async function call<Name extends OperationName>(
    operation: Name,
    request: OperationRequest<Name>,
  ): Promise<OperationResponse<Name>> {
    const definition = operationDefinitions[operation]
    const validatedRequest = strictDecode(definition.request, request, "request", operation)
    const requestFrame = strictDecode(
      RequestFrame,
      { protocolVersion, operation, request: validatedRequest },
      "frame",
      operation,
    )
    const requestJson = stringifyJsonValue(requestFrame, "request", operation)
    const responseJson = await transport.roundTrip(requestJson)
    if (typeof responseJson !== "string") {
      throw new ControlApiCodecError({
        phase: "frame",
        operation,
        message: "Control API transport returned a non-text response",
      })
    }
    const rawResponse = parseJsonText(responseJson, "frame", operation)
    const frame = strictDecode(ResponseFrame, rawResponse, "frame", operation)
    if (frame.operation !== operation) {
      throw new ControlApiCodecError({
        phase: "frame",
        operation,
        message: `Control API response operation mismatch: expected ${operation}, received ${frame.operation}`,
      })
    }
    if (!frame.ok) throw new ControlApiRemoteError(frame.error)
    if (frame.protocolVersion !== protocolVersion) {
      throw new ControlApiCodecError({
        phase: "frame",
        operation,
        message: `Control API response protocol mismatch: expected ${protocolVersion}, received ${frame.protocolVersion}`,
      })
    }
    const response = strictDecode(definition.response, frame.response, "response", operation) as OperationResponse<Name>
    const semanticIssue = validateOperationResponse(operation, validatedRequest, response)
    if (semanticIssue) throw new ControlApiCodecError({ phase: "response", operation, message: semanticIssue })
    return response
  }

  return {
    call,
    handshake: (request) => call("protocol.handshake", request),
    algorithms: {
      list: (request) => call("algorithm.list", request),
      get: (request) => call("algorithm.get", request),
      legalNextActions: (request) => call("algorithm.legal-next-actions", request),
    },
  }
}
