import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage/convex-client"

export async function resetDatabase() {
  await Instance.disposeAll().catch(() => undefined)
  Database.close()
  // Convex is cloud-hosted — no local files to clean up
}
