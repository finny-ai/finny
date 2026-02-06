import { Log } from "../util/log"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import z from "zod"

const log = Log.create({ service: "cost-budget" })

interface CostEntry {
  timestamp: number
  sessionID: string
  cost: number
  model: string
  inputTokens: number
  outputTokens: number
}

interface BudgetConfig {
  sessionLimit: number // Maximum cost per session in dollars
  dailyLimit: number // Maximum cost per day in dollars
  warningThreshold: number // Percentage at which to warn (0-1)
  enforceLimit: boolean // Whether to block requests over budget
}

// Events for budget alerts
export namespace CostBudgetEvent {
  export const Warning = BusEvent.define(
    "cost.budget.warning",
    z.object({
      type: z.enum(["session", "daily"]),
      current: z.number(),
      limit: z.number(),
      percentage: z.number()
    })
  )

  export const LimitReached = BusEvent.define(
    "cost.budget.limit",
    z.object({
      type: z.enum(["session", "daily"]),
      current: z.number(),
      limit: z.number()
    })
  )
}

export namespace CostBudget {
  // Default configuration
  const DEFAULT_CONFIG: BudgetConfig = {
    sessionLimit: 10.0, // $10 per session
    dailyLimit: 50.0, // $50 per day
    warningThreshold: 0.8, // Warn at 80%
    enforceLimit: false, // Don't block by default, just warn
  }

  let config: BudgetConfig = { ...DEFAULT_CONFIG }
  const sessionCosts = new Map<string, number>()
  const dailyCosts = new Map<string, number>() // Key: YYYY-MM-DD
  const costHistory: CostEntry[] = []
  const warningsSent = new Set<string>() // Track warnings to avoid duplicates

  function getTodayKey(): string {
    return new Date().toISOString().split("T")[0]
  }

  function checkWarning(type: "session" | "daily", current: number, limit: number) {
    const percentage = current / limit
    const warningKey = `${type}-${type === "daily" ? getTodayKey() : "session"}-warning`

    if (percentage >= config.warningThreshold && !warningsSent.has(warningKey)) {
      warningsSent.add(warningKey)
      log.warn(`${type} budget warning`, {
        current: current.toFixed(4),
        limit: limit.toFixed(2),
        percentage: (percentage * 100).toFixed(1),
      })
      Bus.publish(CostBudgetEvent.Warning, {
        type,
        current,
        limit,
        percentage,
      })
    }
  }

  function checkLimit(type: "session" | "daily", current: number, limit: number): boolean {
    if (current >= limit) {
      log.error(`${type} budget limit reached`, {
        current: current.toFixed(4),
        limit: limit.toFixed(2),
      })
      Bus.publish(CostBudgetEvent.LimitReached, {
        type,
        current,
        limit,
      })
      return true
    }
    return false
  }

  export function configure(newConfig: Partial<BudgetConfig>) {
    config = { ...config, ...newConfig }
    log.info("cost budget configured", config)
  }

  export function getConfig(): BudgetConfig {
    return { ...config }
  }

  export function recordCost(
    sessionID: string,
    cost: number,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): { allowed: boolean; warning?: string } {
    const todayKey = getTodayKey()

    // Update session cost
    const currentSessionCost = (sessionCosts.get(sessionID) || 0) + cost
    sessionCosts.set(sessionID, currentSessionCost)

    // Update daily cost
    const currentDailyCost = (dailyCosts.get(todayKey) || 0) + cost
    dailyCosts.set(todayKey, currentDailyCost)

    // Record history
    costHistory.push({
      timestamp: Date.now(),
      sessionID,
      cost,
      model,
      inputTokens,
      outputTokens,
    })

    // Trim history to last 1000 entries
    if (costHistory.length > 1000) {
      costHistory.splice(0, costHistory.length - 1000)
    }

    log.debug("cost recorded", {
      sessionID,
      cost: cost.toFixed(6),
      model,
      sessionTotal: currentSessionCost.toFixed(4),
      dailyTotal: currentDailyCost.toFixed(4),
    })

    // Check warnings
    checkWarning("session", currentSessionCost, config.sessionLimit)
    checkWarning("daily", currentDailyCost, config.dailyLimit)

    // Check limits
    const sessionLimitReached = checkLimit("session", currentSessionCost, config.sessionLimit)
    const dailyLimitReached = checkLimit("daily", currentDailyCost, config.dailyLimit)

    if (config.enforceLimit && (sessionLimitReached || dailyLimitReached)) {
      const limitType = sessionLimitReached ? "session" : "daily"
      return {
        allowed: false,
        warning: `${limitType} budget limit reached`,
      }
    }

    // Return warning message if approaching limits
    const sessionPercentage = currentSessionCost / config.sessionLimit
    const dailyPercentage = currentDailyCost / config.dailyLimit

    if (sessionPercentage >= config.warningThreshold) {
      return {
        allowed: true,
        warning: `Session cost at ${(sessionPercentage * 100).toFixed(0)}% of $${config.sessionLimit} limit`,
      }
    }

    if (dailyPercentage >= config.warningThreshold) {
      return {
        allowed: true,
        warning: `Daily cost at ${(dailyPercentage * 100).toFixed(0)}% of $${config.dailyLimit} limit`,
      }
    }

    return { allowed: true }
  }

  export function getSessionCost(sessionID: string): number {
    return sessionCosts.get(sessionID) || 0
  }

  export function getDailyCost(date?: string): number {
    const key = date || getTodayKey()
    return dailyCosts.get(key) || 0
  }

  export function getSessionBudget(sessionID: string) {
    const current = getSessionCost(sessionID)
    return {
      current,
      limit: config.sessionLimit,
      remaining: Math.max(0, config.sessionLimit - current),
      percentage: (current / config.sessionLimit) * 100,
      isOverBudget: current >= config.sessionLimit,
    }
  }

  export function getDailyBudget(date?: string) {
    const current = getDailyCost(date)
    return {
      current,
      limit: config.dailyLimit,
      remaining: Math.max(0, config.dailyLimit - current),
      percentage: (current / config.dailyLimit) * 100,
      isOverBudget: current >= config.dailyLimit,
    }
  }

  export function getStats() {
    const todayKey = getTodayKey()
    const sessions = Array.from(sessionCosts.entries())
    const dailyEntries = Array.from(dailyCosts.entries()).sort().reverse().slice(0, 7)

    // Calculate totals
    const totalAllTime = costHistory.reduce((sum, e) => sum + e.cost, 0)
    const totalToday = dailyCosts.get(todayKey) || 0

    // Top sessions by cost
    const topSessions = sessions
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, cost]) => ({ sessionID: id, cost }))

    // Recent history
    const recentHistory = costHistory.slice(-10).map((e) => ({
      timestamp: new Date(e.timestamp).toISOString(),
      sessionID: e.sessionID,
      cost: e.cost,
      model: e.model,
    }))

    return {
      totalAllTime: Math.round(totalAllTime * 10000) / 10000,
      totalToday: Math.round(totalToday * 10000) / 10000,
      sessionCount: sessions.length,
      sessionBudget: {
        limit: config.sessionLimit,
        warningAt: config.sessionLimit * config.warningThreshold,
      },
      dailyBudget: {
        limit: config.dailyLimit,
        warningAt: config.dailyLimit * config.warningThreshold,
        current: totalToday,
        percentage: (totalToday / config.dailyLimit) * 100,
      },
      enforceLimit: config.enforceLimit,
      dailyHistory: dailyEntries.map(([date, cost]) => ({ date, cost })),
      topSessions,
      recentHistory,
    }
  }

  export function resetSession(sessionID: string) {
    sessionCosts.delete(sessionID)
    const sessionWarningKey = `session-${sessionID}-warning`
    warningsSent.delete(sessionWarningKey)
    log.info("session cost reset", { sessionID })
  }

  export function resetDaily() {
    const todayKey = getTodayKey()
    dailyCosts.delete(todayKey)
    warningsSent.delete(`daily-${todayKey}-warning`)
    log.info("daily cost reset")
  }

  export function reset() {
    sessionCosts.clear()
    dailyCosts.clear()
    costHistory.length = 0
    warningsSent.clear()
    log.info("all cost data reset")
  }
}
