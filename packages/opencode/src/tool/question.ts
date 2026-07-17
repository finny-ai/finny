import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import DESCRIPTION from "./question.txt"
import {
  buildDiscoveryQuestionIssues,
  canonicalBuildDiscoveryQuestions,
  hasCompletedBuildClarification,
  isVagueStrategyBuild,
  latestUserBuildPrompt,
} from "@/session/build-clarification"

export const Parameters = Schema.Struct({
  questions: Schema.mutable(Schema.Array(Question.Prompt)).annotate({ description: "Questions to ask" }),
})

type Metadata = {
  answers: ReadonlyArray<Question.Answer>
  questions: ReadonlyArray<Question.Prompt>
}

export const QuestionTool = Tool.define<typeof Parameters, Metadata, Question.Service>(
  "question",
  Effect.gen(function* () {
    const question = yield* Question.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          let questions: ReadonlyArray<Question.Prompt> = params.questions
          if (
            isVagueStrategyBuild({ agent: ctx.agent, messages: ctx.messages }) &&
            !hasCompletedBuildClarification(ctx.messages)
          ) {
            const prompt = latestUserBuildPrompt(ctx.messages)?.text ?? ""
            const issues = buildDiscoveryQuestionIssues({ prompt, questions: params.questions })
            if (issues.length > 0) {
              questions = canonicalBuildDiscoveryQuestions()
            }
          }
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const formatted = questions
            .map((q, i) => {
              const selected = answers[i] ?? []
              const details = selected.flatMap((answer) => {
                const option = q.options.find((candidate) => candidate.label === answer)
                return option ? [`${answer}: ${option.description}`] : []
              })
              const labels = selected.length ? selected.join(", ") : "Unanswered"
              return `"${q.question}"="${labels}"${details.length ? ` [Selected option details: ${details.join("; ")}]` : ""}`
            })
            .join(", ")

          return {
            title: `Asked ${questions.length} question${questions.length > 1 ? "s" : ""}`,
            output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            metadata: {
              answers,
              questions,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
