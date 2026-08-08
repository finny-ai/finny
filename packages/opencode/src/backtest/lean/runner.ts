import type { LeanAdapterContextV1, LeanAdapterResultV1 } from "./types"

export interface LeanAdapterV1 {
  readonly profileId: "lean_python" | "lean_csharp"
  probeReady(): { ready: boolean; reasons: string[] }
  run(input: LeanAdapterContextV1): Promise<LeanAdapterResultV1>
}

export type { LeanAdapterContextV1, LeanAdapterResultV1 }
