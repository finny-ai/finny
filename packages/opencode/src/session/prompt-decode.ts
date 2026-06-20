import { Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export const decodeMessageInfo = Schema.decodeUnknownExit(SessionV1.Info)
export const decodeMessagePart = Schema.decodeUnknownExit(SessionV1.Part)

export function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}
