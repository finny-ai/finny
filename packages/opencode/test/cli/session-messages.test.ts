import { describe, expect, test } from "bun:test"
import { sessionMessagesPage } from "../../src/cli/cmd/session"

describe("sessionMessagesPage", () => {
  test("includes nextCursor from X-Next-Cursor response header", () => {
    const page = sessionMessagesPage({
      data: [{ id: "msg_1" }],
      response: {
        headers: new Headers({ "X-Next-Cursor": "msg_cursor_2" }),
      },
    })

    expect(page).toEqual({
      messages: [{ id: "msg_1" }],
      nextCursor: "msg_cursor_2",
    })
  })

  test("uses null when the response has no next cursor", () => {
    const page = sessionMessagesPage({
      data: undefined,
      response: {
        headers: new Headers(),
      },
    })

    expect(page).toEqual({
      messages: [],
      nextCursor: null,
    })
  })
})
