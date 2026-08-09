import { Schema } from "effect"
import {
  AuthenticatedRequestContext,
  type AuthenticatedRequestContext as AuthenticatedRequestContextType,
  CONTROL_PROTOCOL_V1,
  CONTROL_PROTOCOL_VERSIONS,
  type ProtocolError,
  ProtocolError as ProtocolErrorSchema,
  RequestFrame,
  ResponseFrame,
  type ServerDescriptor,
} from "./v1"
import {
  type OperationName,
  type OperationRequest,
  type OperationResponse,
  type WireSchema,
  operationDefinitions,
  validateOperationResponse,
} from "./operations"

const strictParseOptions = { errors: "all", onExcessProperty: "error" } as const

export interface ControlApiTransport {
  readonly roundTrip: (requestJson: string) => Promise<string>
}

export class ControlApiCodecError extends Error {
  readonly phase: "frame" | "request" | "response"
  readonly operation?: string

  constructor(options: {
    readonly phase: "frame" | "request" | "response"
    readonly message: string
    readonly operation?: string
    readonly cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = "ControlApiCodecError"
    this.phase = options.phase
    this.operation = options.operation
  }
}

export class ControlApiFault extends Error {
  readonly detail: ProtocolError

  constructor(detail: ProtocolError) {
    super(detail.message)
    this.name = "ControlApiFault"
    this.detail = strictDecode(ProtocolErrorSchema, detail, "response")
  }
}

export class ControlApiRemoteError extends Error {
  readonly detail: ProtocolError

  constructor(detail: ProtocolError) {
    super(detail.message)
    this.name = "ControlApiRemoteError"
    this.detail = detail
  }
}

export function assertJsonValue(
  value: unknown,
  path = "$",
  ancestors = new WeakSet<object>(),
): asserts value is Schema.Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (Number.isFinite(value)) return
    throw new TypeError(`${path} contains a non-finite number`)
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`)
    ancestors.add(value)
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${path}[${index}] is a sparse array entry`)
      assertJsonValue(value[index], `${path}[${index}]`, ancestors)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue
      if (typeof key === "symbol" || !/^(?:0|[1-9]\d*)$/.test(key)) {
        throw new TypeError(`${path} contains a non-JSON array property`)
      }
    }
    ancestors.delete(value)
    return
  }
  if (typeof value !== "object") throw new TypeError(`${path} contains non-JSON ${typeof value}`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} is not a plain JSON object`)
  if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`)
  ancestors.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new TypeError(`${path} contains a symbol key`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path}.${key} is not an enumerable JSON data property`)
    }
    assertJsonValue(descriptor.value, `${path}.${key}`, ancestors)
  }
  ancestors.delete(value)
}

export function parseJsonText(text: string, phase: "frame" | "request" | "response", operation?: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ControlApiCodecError({ phase, operation, message: `Invalid JSON text during ${phase} decoding`, cause })
  }
}

export function stringifyJsonValue(
  value: unknown,
  phase: "frame" | "request" | "response",
  operation?: string,
): string {
  try {
    assertJsonValue(value)
    return JSON.stringify(value)
  } catch (cause) {
    throw new ControlApiCodecError({ phase, operation, message: `Non-JSON value during ${phase} encoding`, cause })
  }
}

export function strictDecode<S extends WireSchema>(
  schema: S,
  input: unknown,
  phase: "frame" | "request" | "response",
  operation?: string,
): Schema.Schema.Type<S> {
  try {
    assertJsonValue(input)
    return Schema.decodeUnknownSync(schema)(input, strictParseOptions)
  } catch (cause) {
    if (cause instanceof ControlApiCodecError) throw cause
    throw new ControlApiCodecError({
      phase,
      operation,
      message: `Control API ${phase} failed schema validation${operation ? ` for ${operation}` : ""}`,
      cause,
    })
  }
}

function normalizeOperation(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9.-]*$/.test(value) ? value : "unknown"
}

function isOperationName(value: string): value is OperationName {
  return Object.hasOwn(operationDefinitions, value)
}

function validationError(phase: "frame" | "request" | "response", cause: unknown, operation?: string): ProtocolError {
  const message = cause instanceof Error ? cause.message : `Control API ${phase} validation failed`
  return strictDecode(
    ProtocolErrorSchema,
    {
      code: "validation_error",
      message,
      phase,
      ...(operation ? { operation } : {}),
    },
    "response",
    operation,
  )
}

function errorFrame(error: ProtocolError, operation: string): string {
  const safeOperation = normalizeOperation(operation)
  const frame = strictDecode(
    ResponseFrame,
    { protocolVersion: CONTROL_PROTOCOL_V1, operation: safeOperation, ok: false, error },
    "response",
    safeOperation,
  )
  return stringifyJsonValue(frame, "response", safeOperation)
}

export type OperationHandler<Name extends Exclude<OperationName, "protocol.handshake">> = (
  request: OperationRequest<Name>,
  context: AuthenticatedRequestContextType,
) => OperationResponse<Name> | Promise<OperationResponse<Name>>

export type ControlApiHandlers = {
  readonly [Name in Exclude<OperationName, "protocol.handshake">]: OperationHandler<Name>
}

async function invoke<Name extends Exclude<OperationName, "protocol.handshake">>(
  name: Name,
  request: OperationRequest<Name>,
  context: AuthenticatedRequestContextType,
  handlers: ControlApiHandlers,
): Promise<OperationResponse<Name>> {
  const handler = handlers[name] as (
    request: OperationRequest<Name>,
    context: AuthenticatedRequestContextType,
  ) => Promise<OperationResponse<Name>> | OperationResponse<Name>
  return handler(request, context)
}

export interface ControlApiDispatcher {
  readonly dispatch: (requestJson: string, context?: AuthenticatedRequestContextType) => Promise<string>
}

export interface ControlApiDispatcherOptions {
  readonly server: ServerDescriptor
  readonly handlers: ControlApiHandlers
}

function forbidden(message: string, requiredScopes: readonly string[]): ProtocolError {
  return { code: "forbidden", message, requiredScopes: [...requiredScopes] }
}

export function createControlApiDispatcher(options: ControlApiDispatcherOptions): ControlApiDispatcher {
  return {
    async dispatch(requestJson, suppliedContext) {
      let rawFrame: unknown
      try {
        rawFrame = parseJsonText(requestJson, "frame")
      } catch (cause) {
        return errorFrame(validationError("frame", cause), "unknown")
      }

      let frame: Schema.Schema.Type<typeof RequestFrame>
      try {
        frame = strictDecode(RequestFrame, rawFrame, "frame")
      } catch (cause) {
        const rawOperation =
          typeof rawFrame === "object" && rawFrame !== null ? Reflect.get(rawFrame, "operation") : undefined
        const operation = normalizeOperation(rawOperation)
        return errorFrame(validationError("frame", cause, operation), operation)
      }

      const operation = frame.operation
      if (frame.protocolVersion !== CONTROL_PROTOCOL_V1) {
        return errorFrame(
          {
            code: "unsupported_protocol_version",
            message: `Unsupported Control API protocol version: ${frame.protocolVersion}`,
            supportedVersions: [...CONTROL_PROTOCOL_VERSIONS],
            requestedVersions: [frame.protocolVersion],
          },
          operation,
        )
      }

      if (!isOperationName(operation)) {
        return errorFrame(
          { code: "unknown_operation", operation, message: `Unknown Control API operation: ${operation}` },
          operation,
        )
      }

      const name = operation
      const definition = operationDefinitions[name]
      let request: unknown
      try {
        request = strictDecode(definition.request, frame.request, "request", operation)
      } catch (cause) {
        return errorFrame(validationError("request", cause, operation), operation)
      }

      let context: AuthenticatedRequestContextType | undefined
      if (definition.authorization.kind === "authenticated") {
        if (!suppliedContext) {
          return errorFrame(forbidden("Authentication is required", definition.authorization.requiredScopes), operation)
        }
        try {
          context = strictDecode(AuthenticatedRequestContext, suppliedContext, "request", operation)
        } catch {
          return errorFrame(
            forbidden("Authenticated request context is invalid", definition.authorization.requiredScopes),
            operation,
          )
        }
        if (!definition.authorization.requiredScopes.every((scope) => context!.scopes.includes(scope))) {
          return errorFrame(
            forbidden("Authenticated actor lacks a required scope", definition.authorization.requiredScopes),
            operation,
          )
        }
        const requestTenant = definition.authorization.tenantId(request)
        if (requestTenant !== context.tenantId) {
          return errorFrame(forbidden("Requested tenant does not match authenticated tenant", []), operation)
        }
      }

      try {
        const response =
          name === "protocol.handshake"
            ? { server: options.server, protocolVersion: CONTROL_PROTOCOL_V1 }
            : await invoke(
                name,
                request as OperationRequest<Exclude<OperationName, "protocol.handshake">>,
                context!,
                options.handlers,
              )
        const validated = strictDecode(definition.response, response, "response", operation)
        const semanticIssue = validateOperationResponse(name, request, validated)
        if (semanticIssue) {
          throw new ControlApiCodecError({ phase: "response", operation, message: semanticIssue })
        }
        const responseFrame = strictDecode(
          ResponseFrame,
          { protocolVersion: CONTROL_PROTOCOL_V1, operation, ok: true, response: validated },
          "response",
          operation,
        )
        return stringifyJsonValue(responseFrame, "response", operation)
      } catch (cause) {
        if (cause instanceof ControlApiFault) return errorFrame(cause.detail, operation)
        if (cause instanceof ControlApiCodecError)
          return errorFrame(validationError("response", cause, operation), operation)
        return errorFrame({ code: "internal_error", message: "Control API handler failed" }, operation)
      }
    },
  }
}

export interface InProcessTransportOptions {
  readonly dispatcher: ControlApiDispatcher
  readonly context?:
    | AuthenticatedRequestContextType
    | (() => AuthenticatedRequestContextType | Promise<AuthenticatedRequestContextType>)
}

export function createInProcessTransport(options: InProcessTransportOptions): ControlApiTransport {
  return {
    async roundTrip(requestJson) {
      const context = typeof options.context === "function" ? await options.context() : options.context
      return options.dispatcher.dispatch(requestJson, context)
    },
  }
}
