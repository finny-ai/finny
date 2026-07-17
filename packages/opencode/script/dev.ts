#!/usr/bin/env bun

import { createHash } from "node:crypto"
import path from "node:path"

export function localDevelopmentDatabase(checkoutRoot: string) {
  const checkout = path.resolve(checkoutRoot)
  const id = createHash("sha256").update(checkout).digest("hex").slice(0, 12)
  return `opencode-local-${id}.db`
}

if (import.meta.main) {
  const checkoutRoot = path.resolve(import.meta.dir, "../../..")
  process.env.OPENCODE_DB ??= localDevelopmentDatabase(checkoutRoot)
  await import("../src/index.ts")
}
