import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  ControlCreateSessionV1,
  ControlPromptV1,
  ControlSnapshotV1,
  CommandReceiptV1,
} from "../../src/control/control-contracts"

describe("control v1 contracts", () => {
  test("ControlSnapshotV1 round-trips the composed overview shape", () => {
    const snapshot = {
      schema: "finny.control_snapshot",
      version: 1,
      capturedAt: "2026-08-09T00:00:00.000Z",
      agents: [
        {
          id: "ses_1",
          directory: "/tmp/project",
          title: "Research SPY",
          agent: "finny",
          status: "busy",
          currentActivity: "walk-forward",
          childCount: 2,
          taskCount: 3,
          pendingQuestionCount: 1,
          pendingPermissionCount: 0,
          timeCreated: 1_000,
          timeUpdated: 2_000,
        },
      ],
      tasks: [],
      crucible: [
        {
          workflowId: "wf_1",
          sessionId: "ses_1",
          workspaceSlug: "spy-1h",
          stage: "backtest_running",
          status: "active",
          phase: "strict_running",
          revision: 4,
          requestVersion: 1,
          updatedAt: 2_000,
        },
      ],
      campaigns: [],
      health: [{ domain: "agents", status: "fresh" }],
    } as const
    const decoded = Schema.decodeUnknownSync(ControlSnapshotV1)(snapshot)
    expect(decoded.schema).toBe("finny.control_snapshot")
    expect(decoded.agents[0]?.status).toBe("busy")
    expect(decoded.crucible[0]?.stage).toBe("backtest_running")
    expect(Schema.encodeSync(ControlSnapshotV1)(decoded)).toEqual(snapshot)
  })

  test("unknown properties do not corrupt known fields", () => {
    const decoded = Schema.decodeUnknownSync(ControlPromptV1)({
      sessionID: "ses_1",
      text: "hello",
      delivery: "steer",
      operationID: "op_1",
      requestHash: "a".repeat(64),
      rogue: "extra",
    })
    expect(decoded.sessionID).toBe("ses_1")
    expect(decoded.delivery).toBe("steer")
  })

  test("command receipts and create-session payloads validate", () => {
    const receipt = Schema.decodeUnknownSync(CommandReceiptV1)({
      operationID: "op_1",
      accepted: true,
      sessionID: "ses_1",
    })
    expect(receipt.accepted).toBe(true)
    const create = Schema.decodeUnknownSync(ControlCreateSessionV1)({
      operationID: "op_2",
      requestHash: "b".repeat(64),
      title: "New run",
      metadata: { campaignID: "cmp_1" },
    })
    expect(create.title).toBe("New run")
    expect(create.metadata?.campaignID).toBe("cmp_1")
  })
})
