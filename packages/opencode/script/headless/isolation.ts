import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const SECRET_ENV_ALLOWLIST = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "ALPACA_API_KEY_ID",
  "ALPACA_API_SECRET_KEY",
  "BINANCE_API_KEY",
  "BINANCE_SECRET_KEY",
  "FINNY_LICENSE_KEY",
] as const

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("could not allocate port"))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

export type HarnessIsolation = {
  root: string
  source: string
  home: string
  finnyHome: string
  database: string
  xdgData: string
  xdgState: string
  xdgCache: string
  xdgConfig: string
  phoenixProject: string
  ports: Record<string, number>
  env: Record<string, string>
  credentialPresence: Array<{ name: string; present: true }>
}

export async function createIsolation(runId: string): Promise<HarnessIsolation> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `finny-headless-${runId}-`))
  const source = path.join(root, "source")
  const home = path.join(root, "home")
  const xdgData = path.join(root, "xdg", "data")
  const xdgState = path.join(root, "xdg", "state")
  const xdgCache = path.join(root, "xdg", "cache")
  const xdgConfig = path.join(root, "xdg", "config")
  const finnyHome = path.join(root, "finny-home")
  const database = path.join(root, "db", "opencode.db")
  await Promise.all(
    [home, xdgData, xdgState, xdgCache, xdgConfig, finnyHome, path.dirname(database)].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  )
  const ports = {
    http: await freePort(),
    phoenixHttp: await freePort(),
    phoenixGrpc: await freePort(),
    scriptedModel: await freePort(),
    fixtureMarketData: await freePort(),
  }
  const phoenixProject = `finny-headless-${runId}`
  const env: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    FINNY_HOME: finnyHome,
    OPENCODE_DB: database,
    BUN_INSTALL_CACHE_DIR: path.join(xdgCache, "bun"),
    UV_CACHE_DIR: path.join(xdgCache, "uv"),
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    FINNY_HARNESS_MODE: "1",
    FINNY_RUN_ID: runId,
    PHOENIX_PROJECT: phoenixProject,
    // Consumer Convex telemetry is orthogonal to the offline harness contract
    // and must not phone home from isolated fixture runs.
    FINNY_TELEMETRY: "0",
    OPENCODE_TELEMETRY: "0",
  }
  if (process.env.FINNY_HARNESS_CONFIG_CONTENT) env.OPENCODE_CONFIG_CONTENT = process.env.FINNY_HARNESS_CONFIG_CONTENT
  const credentialPresence: Array<{ name: string; present: true }> = []
  for (const name of SECRET_ENV_ALLOWLIST) {
    const value = process.env[name]
    if (!value) continue
    env[name] = value
    credentialPresence.push({ name, present: true })
  }
  return {
    root,
    source,
    home,
    finnyHome,
    database,
    xdgData,
    xdgState,
    xdgCache,
    xdgConfig,
    phoenixProject,
    ports,
    env,
    credentialPresence,
  }
}

export function configureCollector(env: Record<string, string>, raw?: string): void {
  if (!raw) return
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("collector endpoint must use http or https")
  }
  if (url.username || url.password) throw new Error("collector endpoint must not contain credentials")
  const normalized = url.toString().replace(/\/$/, "")
  env.PHOENIX_COLLECTOR_ENDPOINT = normalized
}

export function configureTelemetryIdentity(env: Record<string, string>): void {
  const attributes = {
    "finny.run_id": env.FINNY_RUN_ID,
    "git.commit": env.FINNY_GIT_COMMIT,
    "openinference.project.name": env.PHOENIX_PROJECT,
  }
  env.OTEL_RESOURCE_ATTRIBUTES = Object.entries(attributes)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join(",")
}

/**
 * Forward the LEAN execution feature flags into the harness child so a
 * lean_python candidate can run the pinned engine container end-to-end.
 * Absent from the parent, the child sees them disabled and fails closed.
 */
export function configureLeanExecution(env: Record<string, string>): void {
  for (const key of ["FINNY_LEAN_ENABLED", "FINNY_LEAN_ADAPTER_CERT"] as const) {
    const value = process.env[key]
    if (value) env[key] = value
  }
}
