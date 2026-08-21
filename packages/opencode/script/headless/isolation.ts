import fs from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
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

// Probe sockets are closed before fixture services bind their assigned ports.
// Keep the selected numbers reserved for this harness process so concurrent
// isolations cannot receive the same just-released ephemeral port.
const reservedPorts = new Set<number>()

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
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
    if (reservedPorts.has(port)) continue
    reservedPorts.add(port)
    return port
  }
  throw new Error("could not allocate a unique port")
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

/**
 * Real runs may use provider-specific models (notably ``opencode/*``) that are
 * present in the host's model catalog but absent from the compiled snapshot.
 * Seed an isolated catalog path outside the app cache from the host catalog
 * instead of enabling background
 * catalog refresh: the refresher outlives request handling and can race CLI
 * shutdown, disposing the shared Effect runtime underneath it.
 */
export async function seedModelCatalog(isolation: HarnessIsolation): Promise<{
  seeded: boolean
  source: string
}> {
  const source = process.env.OPENCODE_MODELS_PATH ?? path.join(Global.Path.cache, "models.json")
  try {
    const contents = await fs.readFile(source, "utf8")
    JSON.parse(contents)
  } catch {
    return { seeded: false, source }
  }
  // The child performs a versioned cleanup of its entire XDG cache before the
  // first request. Keep the explicit catalog outside that managed directory so
  // startup cannot delete the seed.
  const target = path.join(isolation.root, "catalog", "models.json")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.copyFile(source, target)
  isolation.env.OPENCODE_MODELS_PATH = target
  return { seeded: true, source }
}

/**
 * Real runs need the requested provider's stored credential even though every
 * other isolated-run credential remains empty. Seed only that provider into the
 * auth-content override so fixture runs stay fully synthetic and unrelated
 * host credentials never enter the child.
 */
export async function seedProviderAuth(
  isolation: HarnessIsolation,
  model: string,
): Promise<{ seeded: boolean; source: string; provider?: string }> {
  const provider = model.includes("/") ? model.slice(0, model.indexOf("/")) : model
  const source = path.join(Global.Path.data, "auth.json")
  let credentials: unknown
  try {
    credentials = JSON.parse(await fs.readFile(source, "utf8"))
  } catch {
    return { seeded: false, source }
  }
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    return { seeded: false, source }
  }
  const record = credentials as Record<string, unknown>
  const entry = record[provider]
  if (entry === undefined || entry === null) return { seeded: false, source, provider }
  isolation.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ [provider]: entry })
  return { seeded: true, source, provider }
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
