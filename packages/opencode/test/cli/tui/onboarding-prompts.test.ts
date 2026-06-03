import { expect, test } from "bun:test"
import {
  ONBOARDING_BEGINNER_PROMPT,
  ONBOARDING_TRADER_PROMPT,
} from "../../../src/cli/cmd/tui/component/dialog-onboarding-choose-path"

// The two prompt constants are the visible first message of a real model
// session — see `app.tsx` onboarding-v2 orchestration. If either one is
// emptied or made identical to the other, the welcome session becomes
// confusing (or, for empty, never gets submitted). This guards both.

test("trader and beginner prompts are non-empty", () => {
  expect(ONBOARDING_TRADER_PROMPT.trim().length).toBeGreaterThan(0)
  expect(ONBOARDING_BEGINNER_PROMPT.trim().length).toBeGreaterThan(0)
})

test("trader and beginner prompts are distinct", () => {
  expect(ONBOARDING_TRADER_PROMPT).not.toBe(ONBOARDING_BEGINNER_PROMPT)
})
