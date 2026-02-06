import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createSignal, Show, For, onMount } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import fs from "fs"
import path from "path"

const SIMULATOR_URL = process.env.FINNY_SIMULATOR_URL || "https://api.algoclash.live"

// Local strategy directories to scan
const STRATEGY_DIRS = [
  path.join(process.cwd(), "strategies"),
  path.join(process.cwd(), "packages/opencode/strategies"),
]

interface Strategy {
  name: string
  localPath: string | null
  deployed: boolean
  symbol?: string
  equity?: number
  roi?: number
}

// Helper to get saved username
function getSavedUsername(): string {
  try {
    return localStorage.getItem('finny_username') || ''
  } catch {
    return ''
  }
}

function saveUsername(username: string) {
  try {
    localStorage.setItem('finny_username', username)
  } catch {
    // Ignore storage errors
  }
}

export function DialogDeploy() {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [strategies, setStrategies] = createSignal<Strategy[]>([])
  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [message, setMessage] = createSignal<string | null>(null)
  const [showUsernamePrompt, setShowUsernamePrompt] = createSignal(false)
  const [pendingDeploy, setPendingDeploy] = createSignal<Strategy | null>(null)
  const [username, setUsername] = createSignal(getSavedUsername())

  // Scan local strategy files
  function scanLocalStrategies(): Map<string, string> {
    const localFiles = new Map<string, string>()

    for (const dir of STRATEGY_DIRS) {
      try {
        if (!fs.existsSync(dir)) continue
        const files = fs.readdirSync(dir)
        for (const file of files) {
          if (file.endsWith(".py") && !file.startsWith("__")) {
            const name = file.replace(".py", "")
            if (!localFiles.has(name)) {
              localFiles.set(name, path.join(dir, file))
            }
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }

    return localFiles
  }

  async function fetchStrategies() {
    setLoading(true)
    try {
      // Get local strategy files
      const localFiles = scanLocalStrategies()

      // Get deployed strategies from remote
      const statusRes = await fetch(`${SIMULATOR_URL}/status`)
      const statusData = await statusRes.json()
      const deployedAgents = statusData.agents || {}

      // Build merged list
      const strategyList: Strategy[] = []
      const seen = new Set<string>()

      // Add all local strategies
      for (const [name, filePath] of localFiles) {
        seen.add(name)
        const agent = deployedAgents[name]
        strategyList.push({
          name,
          localPath: filePath,
          deployed: !!agent,
          symbol: agent?.symbol,
          equity: agent?.equity,
          roi: agent?.roi,
        })
      }

      // Add deployed strategies not in local (deployed from elsewhere)
      for (const [name, agent] of Object.entries(deployedAgents)) {
        if (!seen.has(name)) {
          const a = agent as any
          strategyList.push({
            name,
            localPath: null,
            deployed: true,
            symbol: a.symbol,
            equity: a.equity,
            roi: a.roi,
          })
        }
      }

      strategyList.sort((a, b) => a.name.localeCompare(b.name))
      setStrategies(strategyList)
      setError(null)
    } catch {
      setError("Cannot connect to simulator")
    }
    setLoading(false)
  }

  async function deployStrategy(strat: Strategy, confirmedUsername?: string) {
    if (!strat.localPath) {
      setError("No local file for this strategy")
      return
    }

    // If no username provided, prompt for it
    if (!confirmedUsername) {
      setPendingDeploy(strat)
      setShowUsernamePrompt(true)
      return
    }

    setLoading(true)
    setMessage(null)
    setError(null)

    try {
      // Read code from local file
      const code = fs.readFileSync(strat.localPath, "utf-8")

      // Send to remote /deploy endpoint
      const response = await fetch(`${SIMULATOR_URL}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: strat.name,
          code: code,
          symbol: "BTC",
          initial_equity: 10000,
          username: confirmedUsername,
        }),
      })

      if (response.ok) {
        setMessage(`${strat.name} deployed!`)
        await fetchStrategies()
      } else {
        const data = await response.json().catch(() => ({}))
        setError(data.error || "Deploy failed")
      }
    } catch (e: any) {
      setError(e.message || "Deploy failed")
    }
    setLoading(false)
  }

  async function stopStrategy(name: string) {
    setLoading(true)
    setMessage(null)
    setError(null)
    try {
      await fetch(`${SIMULATOR_URL}/agent/${name}`, { method: "DELETE" })
      setMessage(`${name} stopped`)
      await fetchStrategies()
    } catch {
      setError("Stop failed")
    }
    setLoading(false)
  }

  onMount(() => {
    fetchStrategies()
  })

  const selectedStrategy = () => strategies()[selected()]

  useKeyboard((evt) => {
    setMessage(null)

    // Cast to access key property that exists at runtime but not in types
    const evtAny = evt as any
    const key = evtAny.key?.toLowerCase?.() || evtAny.sequence?.toLowerCase?.() || ""

    // Debug: Log what we're receiving
    console.log("Keyboard event:", { name: evt.name, key: evtAny.key, sequence: evtAny.sequence, showUsername: showUsernamePrompt() })

    // Handle username prompt - manual keyboard input
    if (showUsernamePrompt()) {
      if (evt.name === "escape") {
        setShowUsernamePrompt(false)
        setPendingDeploy(null)
        return
      } else if (evt.name === "return") {
        // Submit username and deploy
        const strat = pendingDeploy()
        const user = username().trim() || "anonymous"
        saveUsername(user)
        setShowUsernamePrompt(false)
        setPendingDeploy(null)
        if (strat) {
          deployStrategy(strat, user)
        }
        return
      } else if (evt.name === "backspace") {
        // Remove last character
        setUsername(username().slice(0, -1))
        return
      } else if (evtAny.sequence && evtAny.sequence.length === 1) {
        // Add typed character (single printable chars only)
        const char = evtAny.sequence
        if (/^[a-zA-Z0-9_\-]$/.test(char)) {
          setUsername(username() + char)
        }
        return
      }
      return
    }

    const strats = strategies()
    const maxIdx = Math.max(0, strats.length - 1)

    if (evt.name === "escape") {
      dialog.clear()
    } else if (evt.name === "up" || key === "k") {
      setSelected((s) => Math.max(0, s - 1))
    } else if (evt.name === "down" || key === "j") {
      setSelected((s) => Math.min(maxIdx, s + 1))
    } else if (evt.name === "return" && !loading()) {
      const strat = strats[selected()]
      if (strat) {
        if (strat.deployed) {
          stopStrategy(strat.name)
        } else {
          deployStrategy(strat)
        }
      }
    } else if (key === "r") {
      fetchStrategies()
    }
  })

  // Strategy list
  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>Strategies</text>
        <text fg={theme.textMuted}>esc</text>
      </box>

      {/* Username Prompt Dialog */}
      <Show when={showUsernamePrompt()}>
        <box marginTop={1} marginBottom={1}>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>Deploy Strategy</text>
          <text fg={theme.text} marginTop={1}>
            Deploying: {String(pendingDeploy()?.name ?? "Unknown")}
          </text>
          <text fg={theme.textMuted} marginTop={1}>
            Enter your username (shown on algoclash.live leaderboard):
          </text>
          <box flexDirection="row" marginTop={1}>
            <text fg={theme.text}>Username: </text>
            <text fg={theme.accent}>{username() || "anonymous"}</text>
          </box>
          <text fg={theme.textMuted} marginTop={1}>
            Type username then press Enter • ESC to cancel
          </text>
          <box flexDirection="row" marginTop={1}>
            <text fg={theme.text}>{"> "}</text>
            <text fg={theme.accent}>{username() || "_"}</text>
          </box>
        </box>
      </Show>

      {/* Only show loading/error/message when NOT in username prompt mode */}
      <Show when={!showUsernamePrompt()}>
        <Show when={error()}>
          <text fg={theme.error}>{String(error() ?? "")}</text>
        </Show>

        <Show when={message()}>
          <text fg={theme.success}>{String(message() ?? "")}</text>
        </Show>

        <Show when={loading()}>
          <text fg={theme.textMuted}>Loading...</text>
        </Show>

        <Show when={!loading() && strategies().length === 0 && !error()}>
          <text fg={theme.textMuted}>No strategies found</text>
          <text fg={theme.textMuted}>Add .py files to strategies/ folder</text>
        </Show>

        <Show when={strategies().length > 0}>
          <For each={strategies()}>
            {(strat, i) => (
              <box
                flexDirection="row"
                justifyContent="space-between"
                backgroundColor={selected() === i() ? theme.backgroundElement : undefined}
                paddingLeft={1}
                paddingRight={1}
              >
                <box flexDirection="row" gap={1}>
                  <text fg={strat.deployed ? theme.success : theme.textMuted}>
                    {strat.deployed ? "●" : "○"}
                  </text>
                  <text fg={theme.text}>{strat.name}</text>
                  <Show when={strat.deployed}>
                    <text fg={theme.accent}>[LIVE]</text>
                    <text fg={theme.textMuted}>({strat.symbol ?? "BTC"})</text>
                  </Show>
                  <Show when={!strat.localPath}>
                    <text fg={theme.warning}>[remote]</text>
                  </Show>
                </box>
                <Show when={strat.deployed && strat.roi !== undefined}>
                  <box flexDirection="row" gap={1}>
                    <text fg={(strat.roi ?? 0) >= 0 ? theme.success : theme.error}>
                      {`${(strat.roi ?? 0) >= 0 ? "+" : ""}${Number(strat.roi ?? 0).toFixed(2)}%`}
                    </text>
                    <text fg={theme.textMuted}>{`$${Number(strat.equity ?? 0).toFixed(0)}`}</text>
                  </box>
                </Show>
              </box>
            )}
          </For>
        </Show>

        <box marginTop={1}>
          <text fg={theme.textMuted}>
            {`↑/↓ navigate • Enter ${selectedStrategy()?.deployed ? "stop" : "deploy"} • r refresh`}
          </text>
        </box>
      </Show>
    </box>
  )
}
