import type { Algorithm } from "@/algorithm"
import { writeLeanSourceFile } from "@/backtest/lean/source-store"
import { qcFilesRead } from "./qc-client"
import { isQcFixtureMode, readQcCredentials } from "./quantconnect"

/**
 * Read the full source tree of a QuantConnect project so it can be imported
 * as an immutable Finny algorithm version.
 */
export async function readRemoteContents(
  projectId: number | string,
): Promise<Array<{ path: string; content: string }>> {
  if ((await isQcFixtureMode())) {
    return [{ path: "main.py", content: "class Main(QCAlgorithm):\n    def Initialize(self): pass\n" }]
  }
  const credentials = await readQcCredentials()
  if (!credentials) throw new Error("QuantConnect credentials are not connected")
  const files = await qcFilesRead(credentials, { projectId, includeLibraries: false })
  return files.map((file) => ({ path: file.name, content: file.content }))
}

/** Materialize imported QC source into the algorithm version's LEAN tree. */
export async function materializeRemoteFilesToAlgorithm(
  algorithm: Algorithm.Info,
  contents: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const file of contents) {
    await writeLeanSourceFile({ algorithm, relativePath: file.path, content: file.content })
  }
}
