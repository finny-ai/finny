import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { PromptInfo } from "../prompt/history"
import { useTuiStartup } from "./runtime"

export type HomeRoute = {
  type: "home"
  prompt?: PromptInfo
  initialPrompt?: PromptInfo
  autoSubmit?: boolean
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  prompt?: PromptInfo
}

export type PluginRoute = {
  type: "plugin"
  id: string
  data?: Record<string, unknown>
}

export type SettingsTab =
  | "appearance"
  | "model"
  | "providers"
  | "agents"
  | "mcp"
  | "paper-trading"
  | "data-sources"
  | "skills"

export type SessionsRoute = { type: "sessions" }
export type AlgorithmsRoute = { type: "algorithms"; algorithmId?: string }
export type BacktestsRoute = { type: "backtests" }
export type PortfolioRoute = { type: "portfolio" }
export type PortfolioBuilderRoute = { type: "portfolio-builder"; initialPrompt?: string }
export type SettingsRoute = { type: "settings"; tab?: SettingsTab }

export type Route =
  | HomeRoute
  | SessionRoute
  | PluginRoute
  | SessionsRoute
  | AlgorithmsRoute
  | BacktestsRoute
  | PortfolioRoute
  | PortfolioBuilderRoute
  | SettingsRoute

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "Route",
  init: (props: { initialRoute?: Route }) => {
    const startup = useTuiStartup()
    const [store, setStore] = createStore<Route>(
      props.initialRoute ?? initialRoute(startup.initialRoute) ?? { type: "home" },
    )

    return {
      get data() {
        return store
      },
      navigate(route: Route) {
        setStore(reconcile(route))
      },
      clearInitialPrompt() {
        if (store.type !== "home") return
        setStore(reconcile({ ...store, initialPrompt: undefined, autoSubmit: undefined }))
      },
    }
  },
})

function initialRoute(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string") {
    return { type: "session", sessionID: value.sessionID }
  }
  if (value.type === "plugin" && "id" in value && typeof value.id === "string") {
    return { type: "plugin", id: value.id }
  }
  if (value.type === "sessions") return { type: "sessions" }
  if (value.type === "algorithms") {
    return {
      type: "algorithms",
      algorithmId: "algorithmId" in value && typeof value.algorithmId === "string" ? value.algorithmId : undefined,
    }
  }
  if (value.type === "backtests") return { type: "backtests" }
  if (value.type === "portfolio") return { type: "portfolio" }
  if (value.type === "portfolio-builder") {
    return {
      type: "portfolio-builder",
      initialPrompt: "initialPrompt" in value && typeof value.initialPrompt === "string" ? value.initialPrompt : undefined,
    }
  }
  if (value.type === "settings") {
    return {
      type: "settings",
      tab: "tab" in value && typeof value.tab === "string" ? (value.tab as SettingsTab) : undefined,
    }
  }
}

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
