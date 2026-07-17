export function quantReviewPacketHref(metadata: Record<string, unknown>): string | undefined {
  return typeof metadata.reviewPath === "string" && metadata.reviewPath.length > 0 ? metadata.reviewPath : undefined
}

export function keepCompletedToolVisible(tool: string): boolean {
  return tool === "finny_review_packet"
}
