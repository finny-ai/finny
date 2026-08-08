import { describe, expect, test } from "bun:test"
import {
  classifyWorkspaceEdit,
  workspaceEditApprovalPrompt,
  workspaceEditAttemptCap,
  WORKSPACE_EDIT_MAX_ATTEMPTS,
  type WorkspaceEditIdentity,
} from "../../src/tool/workspace-edit"
import { providerLookbackFloor } from "../../src/data/data-provider-capabilities"

const NOW = new Date("2026-08-02T18:30:00Z")

function identity(overrides: Partial<WorkspaceEditIdentity> = {}): WorkspaceEditIdentity {
  return {
    start: "2025-08-01",
    end: "2026-08-01",
    interval: "1d",
    assetClass: "equity",
    symbols: ["SPY"],
    algorithmName: "spy-momentum",
    ...overrides,
  }
}

describe("provider lookback floor", () => {
  test("returns the documented public yfinance intraday floor", () => {
    expect(providerLookbackFloor({ provider: "yfinance", interval: "5m", now: NOW })).toBe("2026-06-03")
    expect(providerLookbackFloor({ provider: "yfinance", interval: "1m", now: NOW })).toBe("2026-07-03")
  })

  test("returns undefined for providers and intervals with no fixed public floor", () => {
    expect(providerLookbackFloor({ provider: "yfinance", interval: "1d", now: NOW })).toBeUndefined()
    expect(providerLookbackFloor({ provider: "alpaca", interval: "5m", now: NOW })).toBeUndefined()
    expect(providerLookbackFloor({ provider: "yfinance", now: NOW })).toBeUndefined()
  })
})

describe("workspace edit classification", () => {
  test("treats an open-candle end clamp as mechanical", () => {
    // 2026-08-02 is a Sunday, so the last completed XNYS session is Friday.
    const result = classifyWorkspaceEdit({
      current: identity({ end: "2026-08-02" }),
      requested: { endDate: "2026-07-31" },
      now: NOW,
    })
    expect(result).toEqual({ kind: "mechanical", edits: ["requested_end 2026-08-02 → 2026-07-31"] })
  })

  test("requires approval for an end date that is not the last completed candle", () => {
    const result = classifyWorkspaceEdit({
      current: identity(),
      requested: { endDate: "2026-02-01" },
      now: NOW,
    })
    expect(result.kind).toBe("needs_user_approval")
  })

  test("treats a start clamp to a verified provider floor as mechanical", () => {
    const result = classifyWorkspaceEdit({
      current: identity({ interval: "5m" }),
      requested: { startDate: "2026-06-03" },
      provider: "yfinance",
      now: NOW,
    })
    expect(result).toEqual({ kind: "mechanical", edits: ["requested_start 2025-08-01 → 2026-06-03"] })
  })

  test("requires approval for a start clamp the runtime cannot verify", () => {
    // The right shape of edit, but no provider to prove the floor against.
    const noProvider = classifyWorkspaceEdit({
      current: identity({ interval: "5m" }),
      requested: { startDate: "2026-06-03" },
      now: NOW,
    })
    expect(noProvider.kind).toBe("needs_user_approval")

    // A provider whose floor exists but does not match the requested start:
    // this is the 1y→6m shrink the confirmed-identity lock exists to prevent.
    const shrink = classifyWorkspaceEdit({
      current: identity({ interval: "5m" }),
      requested: { startDate: "2026-02-01" },
      provider: "yfinance",
      now: NOW,
    })
    expect(shrink.kind).toBe("needs_user_approval")
  })

  test("never treats an interval change as mechanical", () => {
    const result = classifyWorkspaceEdit({
      current: identity({ interval: "5m" }),
      requested: { interval: "1h" },
      provider: "yfinance",
      now: NOW,
    })
    expect(result.kind).toBe("needs_user_approval")
    if (result.kind !== "needs_user_approval") throw new Error("unreachable")
    expect(result.blockers.join(" ")).toContain("interval changes are never mechanical")
  })

  test("reports no change when the requested values match the bound identity", () => {
    expect(
      classifyWorkspaceEdit({
        current: identity(),
        requested: { startDate: "2025-08-01", endDate: "2026-08-01" },
        now: NOW,
      }),
    ).toEqual({ kind: "no_change" })
  })

  test("rejects an empty window and a workspace with no window to amend", () => {
    expect(
      classifyWorkspaceEdit({
        current: identity(),
        requested: { startDate: "2026-09-01" },
        now: NOW,
      }).kind,
    ).toBe("rejected")

    expect(
      classifyWorkspaceEdit({
        current: identity({ start: undefined, end: undefined }),
        requested: { endDate: "2026-07-31" },
        now: NOW,
      }).kind,
    ).toBe("rejected")
  })

  test("classifies a widening end date as needing approval, not as a clamp", () => {
    const result = classifyWorkspaceEdit({
      current: identity(),
      requested: { endDate: "2027-01-01" },
      now: NOW,
    })
    expect(result.kind).toBe("needs_user_approval")
  })
})

describe("workspace edit guardrails", () => {
  test("caps amendments at the configured attempt budget", () => {
    expect(workspaceEditAttemptCap(0, "BLOCKED: provider limit")).toBeUndefined()
    expect(workspaceEditAttemptCap(WORKSPACE_EDIT_MAX_ATTEMPTS - 1, "BLOCKED: provider limit")).toBeUndefined()
    const capped = workspaceEditAttemptCap(WORKSPACE_EDIT_MAX_ATTEMPTS, "BLOCKED: provider limit")
    expect(capped).toContain("Workspace edit refused")
    expect(capped).toContain("Do not create a new workspace")
  })

  test("the approval prompt names the blocker and offers the research-only alternative", () => {
    const prompt = workspaceEditApprovalPrompt({
      edits: ["requested_start 2025-08-01 → 2026-02-01"],
      blockers: ["shortening history is the user's decision"],
      blocker: "BLOCKED: requested evidence window unavailable",
    })
    expect(prompt).toContain("BLOCKED: requested evidence window unavailable")
    expect(prompt).toContain("`question` tool")
    expect(prompt).toContain("userApproved: true")
    expect(prompt).toContain("research-only")
  })
})
