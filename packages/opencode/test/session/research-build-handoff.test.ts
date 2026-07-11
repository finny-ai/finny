import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { runFinnyPreflight } from "../../src/session/finny-preflight"
import { workspaceEnvDir } from "../../src/python/session-env"
import type { SessionStatus } from "../../src/session/status"

let sandbox: string
let previousXdg: string | undefined

async function fileExists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-research-handoff-"))
  previousXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = sandbox
  delete process.env.FINNY_DISABLE_SESSION_PREFLIGHT
})

afterEach(async () => {
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = previousXdg
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("Research-to-Build preflight", () => {
  test("Research persists an incomplete handoff without provisioning execution resources", async () => {
    const statuses: SessionStatus.Info[] = []
    const result = await Effect.runPromise(
      runFinnyPreflight({
        sessionID: "ses_research_handoff" as any,
        agent: "research",
        prompt: "Plan a SPY 15-minute mean reversion strategy",
        setStatus: (status) =>
          Effect.sync(() => {
            statuses.push(status)
          }),
      }),
    )

    expect(result?.researchOnly).toBe(true)
    expect(result?.envDir).toBe("")
    expect(await fileExists(path.join(result!.workspacePath, "research-brief.json"))).toBe(true)
    expect(await fileExists(workspaceEnvDir(result!.workspacePath))).toBe(false)
    const brief = JSON.parse(await fs.readFile(path.join(result!.workspacePath, "research-brief.json"), "utf8"))
    expect(brief.transition).toBe("draft")
    expect(brief.schema_version).toBe(1)
    expect(statuses.some((status) => status.type === "preflight" && status.message.includes("not provisioned"))).toBe(
      true,
    )
  })

  test("Build refuses an incomplete handoff before provisioning execution resources", async () => {
    const sessionID = "ses_research_build_gate" as any
    const research = await Effect.runPromise(
      runFinnyPreflight({
        sessionID,
        agent: "research",
        prompt: "Plan a SPY 15-minute mean reversion strategy",
        setStatus: () => Effect.void,
      }),
    )

    await expect(
      Effect.runPromise(
        runFinnyPreflight({
          sessionID,
          agent: "build",
          prompt: "Build the approved strategy",
          setStatus: () => Effect.void,
        }),
      ),
    ).rejects.toThrow("Build blocked by ResearchBrief")
    expect(await fileExists(workspaceEnvDir(research!.workspacePath))).toBe(false)
  })

  test("Research clarification edits reuse the handoff and version its exact request identity", async () => {
    const sessionID = "ses_research_edit" as any
    const first = await Effect.runPromise(
      runFinnyPreflight({
        sessionID,
        agent: "research",
        prompt: "Plan a SPY 15-minute mean reversion strategy",
        setStatus: () => Effect.void,
      }),
    )
    const second = await Effect.runPromise(
      runFinnyPreflight({
        sessionID,
        agent: "research",
        prompt: "Use QQQ instead, keeping the 15-minute interval",
        setStatus: () => Effect.void,
      }),
    )

    expect(second?.workspacePath).toBe(first?.workspacePath)
    const request = JSON.parse(await fs.readFile(path.join(second!.workspacePath, "request.json"), "utf8"))
    const brief = JSON.parse(await fs.readFile(path.join(second!.workspacePath, "research-brief.json"), "utf8"))
    expect(request.requested_symbol).toBe("QQQ")
    expect(brief.identity.requested_symbol).toBe("QQQ")
    expect(brief.identity.requested_interval).toBe("15m")
    expect(brief.revision).toBe(2)
    expect(brief.transition).toBe("draft")
  })

  test("Build fails closed when the prompt adds identity facts missing from the research brief", async () => {
    const sessionID = "ses_research_identity_extend" as any
    await Effect.runPromise(
      runFinnyPreflight({
        sessionID,
        agent: "research",
        prompt: "Plan a SPY mean reversion strategy",
        setStatus: () => Effect.void,
      }),
    )

    await expect(
      Effect.runPromise(
        runFinnyPreflight({
          sessionID,
          agent: "build",
          prompt: "Build SPY 15-minute mean reversion from the research plan",
          setStatus: () => Effect.void,
        }),
      ),
    ).rejects.toThrow("request identity does not match the research handoff")
  })
})
