import { expect, test } from "bun:test"
import { showInParentTranscript, todoSnapshot } from "@/cli/cmd/run/footer"
import type { StreamCommit } from "@/cli/cmd/run/types"

function commit(tool: string): StreamCommit {
  return {
    kind: "tool",
    text: "",
    phase: "start",
    source: "tool",
    tool,
  }
}

test.each(["task", "task_start", "task_run", "task_batch_run"])(
  "parent transcript hides %s subagent commits",
  (tool) => {
    expect(showInParentTranscript(commit(tool))).toBe(false)
  },
)

test("parent transcript hides todo snapshots and retains their latest structured state", () => {
  const next = {
    kind: "tool",
    text: "",
    phase: "final",
    source: "tool",
    tool: "todowrite",
    part: {
      type: "tool",
      id: "part-todo",
      sessionID: "session-todo",
      messageID: "message-todo",
      callID: "call-todo",
      tool: "todowrite",
      state: {
        status: "completed",
        input: {
          todos: [
            { status: "completed", content: "Confirm request identity" },
            { status: "in_progress", content: "Run initial backtest" },
          ],
        },
        output: "",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    },
  } as unknown as StreamCommit

  expect(showInParentTranscript(next)).toBe(false)
  expect(todoSnapshot(next)).toEqual({
    kind: "todo",
    items: [
      { status: "completed", content: "Confirm request identity" },
      { status: "in_progress", content: "Run initial backtest" },
    ],
    tail: "",
  })
})

test("parent transcript keeps ordinary tool and assistant commits", () => {
  expect(showInParentTranscript(commit("bash"))).toBe(true)
  expect(
    showInParentTranscript({
      kind: "assistant",
      text: "Done",
      phase: "final",
      source: "assistant",
    }),
  ).toBe(true)
})
