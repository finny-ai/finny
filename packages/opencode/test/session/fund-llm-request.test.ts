import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Plugin } from "../../src/plugin"
import { LLMRequestPrep } from "../../src/session/llm/request"

describe("Fund Manager LLM request preparation", () => {
  test("strips deprecated Gemini sampling fields after plugin transforms", async () => {
    const plugin = {
      trigger: ((name: string, _input: unknown, output: Record<string, unknown>) => {
        if (name !== "chat.params") return Effect.succeed(output)
        return Effect.succeed({
          ...output,
          temperature: 0.7,
          topP: 0.8,
          topK: 20,
          options: {
            ...(output.options as Record<string, unknown>),
            google: {
              top_p: 0.6,
              topK: 10,
              thinkingConfig: {
                thinkingLevel: "low",
                temperature: 0.2,
              },
            },
            preserve: true,
          },
        })
      }) as Plugin.Interface["trigger"],
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    } satisfies Plugin.Interface

    const prepared = await Effect.runPromise(
      LLMRequestPrep.prepare({
        sessionID: "ses-fund",
        user: {
          id: "msg-user",
          sessionID: "ses-fund",
          role: "user",
          time: { created: 0 },
          agent: "fund_manager",
          model: { providerID: "google", modelID: "gemini-3.6-flash" },
        },
        model: {
          id: "gemini-3.6-flash",
          providerID: "google",
          name: "Gemini 3.6 Flash",
          family: "gemini-flash",
          release_date: "2026-07-01",
          api: {
            id: "gemini-3.6-flash",
            url: "https://generativelanguage.googleapis.com",
            npm: "@ai-sdk/google",
          },
          capabilities: {
            temperature: true,
            reasoning: true,
            toolcall: true,
            attachment: false,
            input: { text: true, image: false, audio: false, video: false },
            output: { text: true, image: false, audio: false, video: false },
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 1_000_000, input: 1_000_000, output: 64_000 },
          status: "active",
          options: {
            top_p: 0.5,
            thinkingConfig: { thinkingLevel: "low" },
          },
          headers: {},
          variants: {},
        },
        agent: {
          name: "fund_manager",
          mode: "primary",
          native: true,
          hidden: true,
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
          options: { top_k: 12 },
          temperature: 0.3,
          topP: 0.4,
        },
        system: [],
        messages: [],
        tools: {},
        provider: {
          id: "google",
          name: "Google",
          source: "api",
          env: [],
          options: {},
          models: {},
        },
        auth: undefined,
        plugin,
        flags: {
          client: "cli",
          outputTokenMax: undefined,
        },
        isWorkflow: false,
      } as never),
    )

    expect(prepared.params.temperature).toBeUndefined()
    expect(prepared.params.topP).toBeUndefined()
    expect(prepared.params.topK).toBeUndefined()
    expect(prepared.params.options).toEqual({
      google: { thinkingConfig: { thinkingLevel: "low" } },
      preserve: true,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
    })
    expect(prepared.messageTransformOptions).toEqual({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "low" },
    })
  })
})
