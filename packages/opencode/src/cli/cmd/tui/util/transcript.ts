import type { AssistantMessage, Part, Provider, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import * as Model from "./model"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  providers?: Provider[]
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

// Common secret shapes that can leak through tool inputs/outputs when a full
// transcript (tool details included) is copied to the clipboard. This is a
// best-effort scrub, not a guarantee — it masks the obvious high-risk tokens
// (provider API keys, bearer/auth headers, cloud keys) before the text leaves
// the app.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Provider API keys: sk-..., sk-ant-..., etc.
  [/\bsk-[A-Za-z0-9-_]{16,}\b/g, "sk-[REDACTED]"],
  // GitHub fine-grained PATs: github_pat_<22>_<59> (longest prefix first so the
  // classic-token rule below doesn't partially match it).
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]"],
  // GitHub classic tokens: ghp_, gho_, ghu_, ghs_, ghr_
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "gh_[REDACTED]"],
  // Slack tokens: xoxb-, xoxp-, xoxa-, xoxr-
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "xox-[REDACTED]"],
  // Google API keys
  [/\bAIza[A-Za-z0-9\-_]{35}\b/g, "AIza[REDACTED]"],
  // AWS access key IDs
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]"],
  // Bearer / Authorization header values
  [/\b([Bb]earer\s+)[A-Za-z0-9\-._~+/]{12,}=*/g, "$1[REDACTED]"],
  // JSON key/value pairs whose key name looks sensitive
  [
    /("(?:[^"]*(?:api[_-]?key|secret|token|password|passwd|authorization|access[_-]?key)[^"]*)"\s*:\s*")[^"]+(")/gi,
    "$1[REDACTED]$2",
  ],
  // Shell/env-style assignments for sensitive names: API_KEY=..., SECRET=...
  [/\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|AUTH)[A-Z0-9_]*\s*=\s*)\S+/g, "$1[REDACTED]"],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  const providers = Model.index(options.providers)
  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  transcript += `---\n\n`

  for (const msg of messages) {
    transcript += formatMessage(msg.info, msg.parts, options, providers)
    transcript += `---\n\n`
  }

  // Best-effort scrub of common secret patterns before the transcript can be
  // copied/shared. Applied to the assembled output so it covers tool inputs,
  // tool outputs, and free text uniformly.
  return redactSecrets(transcript)
}

export function formatMessage(
  msg: UserMessage | AssistantMessage,
  parts: Part[],
  options: TranscriptOptions,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  let result = ""

  if (msg.role === "user") {
    result += `## User\n\n`
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata, providers ?? options.providers)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(
  msg: AssistantMessage,
  includeMetadata: boolean,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  const modelName = Model.name(providers, msg.providerID, msg.modelID)

  return `## Assistant (${Locale.titlecase(msg.agent)} · ${modelName}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `**Tool: ${part.tool}**\n`
    if (options.toolDetails && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`
    }
    result += `\n`
    return result
  }

  return ""
}
