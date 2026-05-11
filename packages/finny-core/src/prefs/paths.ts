import { homedir } from "node:os"
import path from "node:path"
import { PREFS_FILENAME } from "./schemas"

export function userDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA
    if (local && local.length > 0) return path.join(local, "finny")
    return path.join(homedir(), "AppData", "Local", "finny")
  }
  const xdg = env.XDG_DATA_HOME
  if (xdg && xdg.length > 0) return path.join(xdg, "finny")
  return path.join(homedir(), ".local", "share", "finny")
}

export function userPrefsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(userDataRoot(env, platform), PREFS_FILENAME)
}
