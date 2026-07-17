export * as PerplexitySearch from "./perplexity-search"

import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export const API_URL = "https://api.perplexity.ai/search"
export const MAX_RESULTS = 20

const Request = Schema.Struct({
  query: Schema.String,
  max_results: Schema.Number,
})

const Result = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.String,
  date: Schema.optional(Schema.NullOr(Schema.String)),
  last_updated: Schema.optional(Schema.NullOr(Schema.String)),
})

const Response = Schema.Struct({
  results: Schema.Array(Result),
})

function formatResult(result: typeof Result.Type, index: number) {
  const date = result.date ?? result.last_updated
  return [
    `${index + 1}. ${result.title}`,
    `URL: ${result.url}`,
    ...(date ? [`Date: ${date}`] : []),
    result.snippet,
  ].join("\n")
}

export function format(results: ReadonlyArray<typeof Result.Type>, maxCharacters?: number) {
  if (results.length === 0) return undefined
  const output = ["Perplexity search results:", ...results.map(formatResult)].join("\n\n")
  if (!maxCharacters || output.length <= maxCharacters) return output
  return `${output.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`
}

export const search = Effect.fn("PerplexitySearch.search")(function* (
  http: HttpClient.HttpClient,
  input: {
    readonly apiKey: string
    readonly query: string
    readonly numResults?: number
    readonly maxCharacters?: number
  },
) {
  if (!input.apiKey) return yield* Effect.fail(new Error("PERPLEXITY_API_KEY is required for Perplexity web search"))

  const maxResults = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(input.numResults || 8)))
  const request = yield* HttpClientRequest.post(API_URL).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(input.apiKey),
    HttpClientRequest.schemaBodyJson(Request)({ query: input.query, max_results: maxResults }),
  )
  const response = yield* HttpClient.filterStatusOk(http).execute(request)
  const body = yield* HttpClientResponse.schemaBodyJson(Response)(response)
  return format(body.results, input.maxCharacters)
})
