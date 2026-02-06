import { Log } from "../util/log"
import { Bus } from "../bus"
import { BusEvent } from "../bus/bus-event"
import z from "zod"

const log = Log.create({ service: "provider-health" })

interface HealthRecord {
  providerID: string
  consecutiveFailures: number
  totalRequests: number
  totalFailures: number
  totalSuccesses: number
  averageLatencyMs: number
  lastSuccess: number | null
  lastFailure: number | null
  lastError: string | null
  isHealthy: boolean
}

// Events for health state changes
export namespace ProviderHealthEvent {
  export const Unhealthy = BusEvent.define(
    "provider.health.unhealthy",
    z.object({
      providerID: z.string(),
      consecutiveFailures: z.number(),
      error: z.string()
    })
  )

  export const Recovered = BusEvent.define(
    "provider.health.recovered",
    z.object({
      providerID: z.string(),
      downtime: z.number()
    })
  )
}

export namespace ProviderHealth {
  const FAILURE_THRESHOLD = 3 // Number of consecutive failures before marking unhealthy
  const RECOVERY_SUCCESSES = 2 // Number of successes needed to mark healthy again
  const LATENCY_WINDOW = 100 // Number of requests to average latency over

  // In-memory store for health records
  const healthRecords = new Map<string, HealthRecord>()
  const latencyHistory = new Map<string, number[]>()
  let recoverySuccessCount = new Map<string, number>()

  function getOrCreateRecord(providerID: string): HealthRecord {
    let record = healthRecords.get(providerID)
    if (!record) {
      record = {
        providerID,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        averageLatencyMs: 0,
        lastSuccess: null,
        lastFailure: null,
        lastError: null,
        isHealthy: true,
      }
      healthRecords.set(providerID, record)
    }
    return record
  }

  function updateAverageLatency(providerID: string, latencyMs: number) {
    let history = latencyHistory.get(providerID)
    if (!history) {
      history = []
      latencyHistory.set(providerID, history)
    }

    history.push(latencyMs)
    if (history.length > LATENCY_WINDOW) {
      history.shift()
    }

    return history.reduce((a, b) => a + b, 0) / history.length
  }

  export function recordSuccess(providerID: string, latencyMs: number) {
    const record = getOrCreateRecord(providerID)
    const wasUnhealthy = !record.isHealthy

    record.totalRequests++
    record.totalSuccesses++
    record.consecutiveFailures = 0
    record.lastSuccess = Date.now()
    record.averageLatencyMs = updateAverageLatency(providerID, latencyMs)

    // Check for recovery
    if (wasUnhealthy) {
      const successCount = (recoverySuccessCount.get(providerID) || 0) + 1
      recoverySuccessCount.set(providerID, successCount)

      if (successCount >= RECOVERY_SUCCESSES) {
        record.isHealthy = true
        recoverySuccessCount.delete(providerID)

        const downtime = record.lastFailure ? Date.now() - record.lastFailure : 0
        log.info("provider recovered", { providerID, downtime })
        Bus.publish(ProviderHealthEvent.Recovered, { providerID, downtime })
      }
    }

    log.debug("provider success", {
      providerID,
      latencyMs,
      avgLatency: Math.round(record.averageLatencyMs),
    })
  }

  export function recordFailure(providerID: string, error: string) {
    const record = getOrCreateRecord(providerID)
    const wasHealthy = record.isHealthy

    record.totalRequests++
    record.totalFailures++
    record.consecutiveFailures++
    record.lastFailure = Date.now()
    record.lastError = error
    recoverySuccessCount.delete(providerID)

    // Check if we should mark as unhealthy
    if (wasHealthy && record.consecutiveFailures >= FAILURE_THRESHOLD) {
      record.isHealthy = false
      log.warn("provider unhealthy", {
        providerID,
        consecutiveFailures: record.consecutiveFailures,
        error,
      })
      Bus.publish(ProviderHealthEvent.Unhealthy, {
        providerID,
        consecutiveFailures: record.consecutiveFailures,
        error,
      })
    } else {
      log.debug("provider failure", {
        providerID,
        consecutiveFailures: record.consecutiveFailures,
        error,
      })
    }
  }

  export function isHealthy(providerID: string): boolean {
    const record = healthRecords.get(providerID)
    return record?.isHealthy ?? true // Unknown providers are assumed healthy
  }

  export function getHealthyProviders(providerIDs: string[]): string[] {
    return providerIDs.filter((id) => isHealthy(id))
  }

  export function getUnhealthyProviders(providerIDs: string[]): string[] {
    return providerIDs.filter((id) => !isHealthy(id))
  }

  export function getRecord(providerID: string): HealthRecord | undefined {
    return healthRecords.get(providerID)
  }

  export function getAllRecords(): HealthRecord[] {
    return Array.from(healthRecords.values())
  }

  export function getStats() {
    const records = getAllRecords()
    const healthyCount = records.filter((r) => r.isHealthy).length
    const unhealthyCount = records.filter((r) => !r.isHealthy).length

    const totalRequests = records.reduce((sum, r) => sum + r.totalRequests, 0)
    const totalFailures = records.reduce((sum, r) => sum + r.totalFailures, 0)
    const overallSuccessRate = totalRequests > 0
      ? ((totalRequests - totalFailures) / totalRequests) * 100
      : 100

    return {
      totalProviders: records.length,
      healthyCount,
      unhealthyCount,
      totalRequests,
      totalFailures,
      overallSuccessRate: Math.round(overallSuccessRate * 100) / 100,
      providers: records.map((r) => ({
        providerID: r.providerID,
        isHealthy: r.isHealthy,
        consecutiveFailures: r.consecutiveFailures,
        successRate: r.totalRequests > 0
          ? Math.round((r.totalSuccesses / r.totalRequests) * 10000) / 100
          : 100,
        averageLatencyMs: Math.round(r.averageLatencyMs),
        lastError: r.lastError,
      })),
    }
  }

  export function reset(providerID?: string) {
    if (providerID) {
      healthRecords.delete(providerID)
      latencyHistory.delete(providerID)
      recoverySuccessCount.delete(providerID)
    } else {
      healthRecords.clear()
      latencyHistory.clear()
      recoverySuccessCount.clear()
    }
  }

  // Manual health management
  export function markHealthy(providerID: string) {
    const record = getOrCreateRecord(providerID)
    record.isHealthy = true
    record.consecutiveFailures = 0
    recoverySuccessCount.delete(providerID)
    log.info("provider manually marked healthy", { providerID })
  }

  export function markUnhealthy(providerID: string, reason: string) {
    const record = getOrCreateRecord(providerID)
    record.isHealthy = false
    record.lastError = reason
    log.info("provider manually marked unhealthy", { providerID, reason })
  }
}
