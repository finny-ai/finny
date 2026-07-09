import { describe, expect, test } from "bun:test"
import { filterSessionEntries, sessionMessagesPage } from "../../src/cli/cmd/session"

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

describe("filterSessionEntries", () => {
  const entries = [
    {
      id: "ses_finny",
      title: "finny session",
      agent: "finny",
      projectID: "proj_1",
      directory: "/tmp/a",
      time: { created: 1, updated: 2 },
    },
    {
      id: "ses_build",
      title: "build session",
      agent: "build",
      projectID: "proj_1",
      directory: "/tmp/b",
      time: { created: 3, updated: 4 },
    },
  ]

  test("filters by mode", () => {
    expect(filterSessionEntries(entries, { mode: "finny" }).map((entry) => entry.id)).toEqual(["ses_finny"])
  })

  test("returns all entries when no mode filter is supplied", () => {
    expect(filterSessionEntries(entries, {}).map((entry) => entry.id)).toEqual(["ses_finny", "ses_build"])
  })
})
