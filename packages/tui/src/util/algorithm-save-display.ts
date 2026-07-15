export function algorithmSaveFailureDisplay(input: Record<string, unknown>, output?: string) {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined
  return {
    title: name ? `Failed to save "${name}"` : "Failed to save strategy",
    output: output?.trim() || "Failed to save strategy: no validation reason was returned.",
  }
}
