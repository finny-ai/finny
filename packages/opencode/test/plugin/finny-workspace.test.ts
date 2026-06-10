import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { getSessionWorkspace, setActiveAlgo, ensureAlgoWorkspace, algoDir } from "@finny-ai/core/algo"
import {
  bootstrapWorkspace,
  deriveIntent,
  deriveWorkspaceName,
  linkAlgorithmToWorkspace,
  mirrorNewsToWorkspace,
} from "../../src/plugin/finny-workspace"
import { resolveTargetWorkspace } from "../../src/tool/extract-data"
import { parseRequestFacts } from "../../src/agent/request-identity"

const SPY_PROMPT =
  "Build a new SPY 15-minute mean reversion strategy with $10,000 over 3 months. Keep it clean and validate/backtest it in strict mode."

let sandbox: string
let prevXdg: string | undefined

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "finny-ws-boot-"))
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = sandbox
})

afterEach(async () => {
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prevXdg
  await fs.rm(sandbox, { recursive: true, force: true })
})

describe("workspace naming", () => {
  test("derives intent from the prompt", () => {
    expect(deriveIntent(SPY_PROMPT)).toBe("mean-reversion")
    expect(deriveIntent("build a BTC momentum bot")).toBe("momentum")
    expect(deriveIntent("what is a sharpe ratio?")).toBeUndefined()
  })

  test("derives a kebab workspace name from request facts", () => {
    const facts = parseRequestFacts(SPY_PROMPT)
    expect(deriveWorkspaceName(facts, "mean-reversion")).toBe("spy-15m-mean-reversion")
  })

  test("no symbol means no name", () => {
    expect(deriveWorkspaceName({}, "momentum")).toBeUndefined()
  })
})

describe("bootstrapWorkspace (the prompt-in startup routine)", () => {
  test("SPY build prompt provisions a workspace, binds the session, writes request.json", async () => {
    const result = await bootstrapWorkspace("ses_spy1", SPY_PROMPT)
    expect(result).toBeDefined()
    expect(result!.slug.startsWith("spy-15m-mean-reversion.")).toBe(true)
    expect(result!.created).toBe(true)

    expect(await getSessionWorkspace("ses_spy1")).toBe(result!.slug)

    const request = JSON.parse(await fs.readFile(path.join(result!.dir, "request.json"), "utf8"))
    expect(request.requested_symbol).toBe("SPY")
    expect(request.requested_interval).toBe("15m")
    expect(request.requested_asset_class).toBe("equity")
    expect(request.request_id).toBe("ses_spy1")
  })

  test("conceptual prompt creates nothing", async () => {
    const result = await bootstrapWorkspace("ses_concept", "what is a sharpe ratio and why does it matter?")
    expect(result).toBeUndefined()
    expect(await getSessionWorkspace("ses_concept")).toBeNull()
  })

  test("second prompt in the same session reuses the binding", async () => {
    const first = await bootstrapWorkspace("ses_same", SPY_PROMPT)
    const second = await bootstrapWorkspace("ses_same", "tighten the SPY 15-minute mean reversion stops")
    expect(second!.slug).toBe(first!.slug)
    expect(second!.created).toBe(false)
    expect(second!.rebound).toBe(false)
  })

  test("conflicting symbol in the same session rebinds to a fresh workspace", async () => {
    const first = await bootstrapWorkspace("ses_pivot", SPY_PROMPT)
    const second = await bootstrapWorkspace("ses_pivot", "now build a BTC 5-minute momentum strategy")
    expect(second!.slug).not.toBe(first!.slug)
    expect(second!.slug.startsWith("btc-5m-momentum.")).toBe(true)
    expect(second!.rebound).toBe(true)
    expect(await getSessionWorkspace("ses_pivot")).toBe(second!.slug)
  })
})

describe("resolveTargetWorkspace (leak regression)", () => {
  test("ignores a stale global active-algo marker pointing at another algo", async () => {
    // Recreate the real incident: the machine-global marker points at the BTC
    // workspace from a previous session; a SPY request must NOT land there.
    const btc = await ensureAlgoWorkspace("btc-usdt-5m-momentum")
    await setActiveAlgo(btc.slug)

    const resolved = await resolveTargetWorkspace({
      canonicalSymbol: "SPY",
      interval: "15m",
      sessionID: "ses_leak_regress",
    })

    expect(resolved.slug).not.toBe(btc.slug)
    expect(resolved.slug.startsWith("spy-15m-pending.")).toBe(true)
    expect(resolved.source).toBe("pending")
    // and the fresh workspace is now bound for consistency
    expect(await getSessionWorkspace("ses_leak_regress")).toBe(resolved.slug)
  })

  test("uses the session-bound workspace when it matches the request", async () => {
    const boot = await bootstrapWorkspace("ses_match", SPY_PROMPT)
    const resolved = await resolveTargetWorkspace({
      canonicalSymbol: "SPY",
      interval: "15m",
      sessionID: "ses_match",
    })
    expect(resolved.slug).toBe(boot!.slug)
    expect(resolved.source).toBe("session")
  })

  test("ignores a session binding whose slug conflicts with the requested symbol", async () => {
    const btc = await bootstrapWorkspace("ses_conflict", "build a BTC 5-minute momentum strategy")
    const resolved = await resolveTargetWorkspace({
      canonicalSymbol: "SPY",
      interval: "15m",
      sessionID: "ses_conflict",
    })
    expect(resolved.slug).not.toBe(btc!.slug)
    expect(resolved.slug.startsWith("spy-15m-pending.")).toBe(true)
  })

  test("explicit algorithm_name wins", async () => {
    const resolved = await resolveTargetWorkspace({
      algorithmName: "my-existing-algo",
      canonicalSymbol: "SPY",
      interval: "15m",
      sessionID: "ses_explicit",
    })
    expect(resolved.slug.startsWith("my-existing-algo.")).toBe(true)
    expect(resolved.source).toBe("explicit")
  })
})

describe("session consolidation", () => {
  test("saved algorithms are linked into the workspace with a manifest", async () => {
    const boot = await bootstrapWorkspace("ses_consol", SPY_PROMPT)
    const link = await linkAlgorithmToWorkspace("ses_consol", {
      algorithmId: "aaaa-bbbb",
      name: "spy-15m-mean-reversion",
      version: 3,
    })
    expect(link).toBe(path.join(boot!.dir, "algorithms", "spy-15m-mean-reversion"))
    const target = await fs.readlink(link!)
    expect(target.endsWith(path.join("algorithms", "aaaa-bbbb"))).toBe(true)

    const manifest = JSON.parse(await fs.readFile(path.join(boot!.dir, "manifest.json"), "utf8"))
    expect(manifest.algorithms).toHaveLength(1)
    expect(manifest.algorithms[0]).toMatchObject({
      name: "spy-15m-mean-reversion",
      algorithmId: "aaaa-bbbb",
      latest_version: 3,
    })
  })

  test("re-saving the same algorithm updates the manifest entry, no duplicate", async () => {
    const boot = await bootstrapWorkspace("ses_consol2", SPY_PROMPT)
    await linkAlgorithmToWorkspace("ses_consol2", { algorithmId: "id-1", name: "spy-x", version: 1 })
    await linkAlgorithmToWorkspace("ses_consol2", { algorithmId: "id-1", name: "spy-x", version: 2 })
    const manifest = JSON.parse(await fs.readFile(path.join(boot!.dir, "manifest.json"), "utf8"))
    expect(manifest.algorithms).toHaveLength(1)
    expect(manifest.algorithms[0].latest_version).toBe(2)
  })

  test("unbound session does not link", async () => {
    expect(await linkAlgorithmToWorkspace("ses_nobind", { algorithmId: "x", name: "y", version: 1 })).toBeUndefined()
  })

  test("research notes written to a repo-local algos dir are mirrored into the workspace", async () => {
    const boot = await bootstrapWorkspace("ses_news", SPY_PROMPT)
    const repoNews = path.join(sandbox, "repo", "algos", "spy-15m-mean-reversion", "data", "news")
    await fs.mkdir(repoNews, { recursive: true })
    const src = path.join(repoNews, "intraday-reversal-rate-spikes.md")
    await fs.writeFile(src, "# reversal data\n", "utf8")

    const dest = await mirrorNewsToWorkspace("ses_news", src)
    expect(dest).toBe(path.join(boot!.dir, "data", "news", "intraday-reversal-rate-spikes.md"))
    expect(await fs.readFile(dest!, "utf8")).toBe("# reversal data\n")
  })

  test("notes already inside the workspace are not re-mirrored", async () => {
    const boot = await bootstrapWorkspace("ses_news2", SPY_PROMPT)
    const inWs = path.join(algoDir(boot!.slug), "data", "news", "note.md")
    await fs.mkdir(path.dirname(inWs), { recursive: true })
    await fs.writeFile(inWs, "x", "utf8")
    expect(await mirrorNewsToWorkspace("ses_news2", inWs)).toBeUndefined()
  })

  test("non-news writes are ignored", async () => {
    await bootstrapWorkspace("ses_news3", SPY_PROMPT)
    expect(await mirrorNewsToWorkspace("ses_news3", "/tmp/whatever/readme.md")).toBeUndefined()
  })
})
