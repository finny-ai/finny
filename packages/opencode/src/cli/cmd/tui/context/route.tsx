import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../component/prompt/history"

export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type AlgorithmsRoute = { type: "algorithms" }
export type BacktestsRoute = { type: "backtests" }
export type PortfolioRoute = { type: "portfolio" }
export type SessionsRoute = { type: "sessions" }
export type SettingsTab = "appearance" | "model" | "providers" | "mcp" | "agents" | "paper-trading" | "skills" | "pro"
export type SettingsRoute = { type: "settings"; tab?: SettingsTab }

export type Route =
  | HomeRoute
  | SessionRoute
  | PluginRoute
  | AlgorithmsRoute
  | BacktestsRoute
  | PortfolioRoute
  | SessionsRoute
  | SettingsRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: () => {
    const [store, setStore] = createStore<Route>(
      process.env["OPENCODE_ROUTE"]
        ? JSON.parse(process.env["OPENCODE_ROUTE"])
        : {
            type: "home",
          },
    )

    return {
      get data() {
        return store
      },
      // `reconcile` instead of plain setStore so navigation REPLACES the
      // store (deep diff to the new value) instead of merging top-level
      // keys. Without this, fields from the previous route — e.g.
      // `initialPrompt` set by a /examples click — leak into the next
      // route, which is how the session view ended up with the same
      // template text the home prompt just submitted.
      navigate(route: Route) {
        setStore(reconcile(route))
      },
      // Clear `initialPrompt` after a route applies it, so re-mounting the
      // same route (or a sibling route reading the same field) doesn't
      // re-apply stale state. Idempotent — safe to call when the field is
      // already absent.
      clearInitialPrompt() {
        if ((store as any).initialPrompt !== undefined) {
          setStore("initialPrompt" as any, undefined)
        }
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
