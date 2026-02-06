import { Tool } from "./tool"
import z from "zod"

// These are simple "signal" tools that indicate the AI has completed a phase
// and is ready to transition to Build mode. The TUI detects when these tools
// complete and shows a transition prompt to the user.

export const QuantResearchCompleteTool = Tool.define("quant_research_complete", async () => {
  return {
    description:
      "Signal that research phase is complete and you're ready to transition to Build mode. " +
      "Use this when you have finished analyzing data and designing a trading strategy. " +
      "The user will be prompted to confirm the transition to Build mode.",
    parameters: z.object({
      summary: z
        .string()
        .optional()
        .describe("Optional brief summary of research findings and strategy design"),
    }),
    async execute(params) {
      return {
        title: "Research complete",
        output: params.summary
          ? `Research complete. Summary: ${params.summary}`
          : "Research phase complete. Ready to transition to Build mode for implementation.",
        metadata: {},
      }
    },
  }
})

