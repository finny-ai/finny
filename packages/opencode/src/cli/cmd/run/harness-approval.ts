type QuestionRequest = { questions?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** A hermetic harness may act as the explicit user for one exact sealed-holdout approval. */
export function harnessSealedHoldoutAnswers(
  request: QuestionRequest,
  env: Record<string, string | undefined> = process.env,
): string[][] | undefined {
  if (
    env.FINNY_HARNESS_MODE !== "1" ||
    env.FINNY_HARNESS_SCRIPTED_MODEL !== "1" ||
    env.FINNY_HARNESS_APPROVE_SEALED_HOLDOUT !== "1"
  )
    return undefined
  if (!Array.isArray(request.questions) || request.questions.length !== 1) return undefined
  const question: unknown = request.questions[0]
  if (!isRecord(question)) return undefined
  if (question.header !== "Open holdout" || typeof question.question !== "string") return undefined
  if (!question.question.includes("Experiment plan:") || !question.question.includes("Plan hash:")) return undefined
  if (!question.question.includes("Qualification policy:")) return undefined
  if (!Array.isArray(question.options)) return undefined
  const labels = question.options.map((option: unknown) =>
    isRecord(option) && typeof option.label === "string" ? option.label : "",
  )
  if (labels.length !== 2 || labels[0] !== "Approve" || labels[1] !== "Reject") return undefined
  return [["Approve"]]
}
