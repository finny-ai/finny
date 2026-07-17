import path from "path"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { BrokerRegistry } from "./index"
import type { BrokerKind } from "./types"

// Path the TUI's `local.brokerage` IIFE writes to. The agent runtime reads
// the same file so the user's per-session selection flows into prompt
// composition and algorithm-save without needing to plumb it through every
// message envelope.
const BROKERAGE_STATE_FILE = path.join(Global.Path.state, "brokerage.json")

export async function readActiveBrokerKind(): Promise<BrokerKind | null> {
  try {
    const raw = await Filesystem.readJson(BROKERAGE_STATE_FILE)
    const current = (raw as any)?.current
    if (typeof current !== "string") return null
    const match = BrokerRegistry.specs().find((s) => s.kind === current)
    return match ? match.kind : null
  } catch {
    return null
  }
}
