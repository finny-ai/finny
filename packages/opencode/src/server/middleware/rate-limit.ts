import type { Context, Next } from "hono"
import { Log } from "../../util/log"

const log = Log.create({ service: "rate-limit" })

interface RateLimitEntry {
  count: number
  resetTime: number
}

interface RateLimitConfig {
  windowMs: number // Time window in milliseconds
  maxRequests: number // Maximum requests per window
  keyGenerator?: (c: Context) => string // Custom key generator
  skip?: (c: Context) => boolean // Skip rate limiting for certain requests
  onRateLimited?: (c: Context) => void // Callback when rate limited
}

const DEFAULT_CONFIG: Required<RateLimitConfig> = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100,
  keyGenerator: (c) => {
    // Use X-Forwarded-For if available, otherwise use remote IP
    const forwarded = c.req.header("x-forwarded-for")
    if (forwarded) {
      return forwarded.split(",")[0].trim()
    }
    // Fallback to a default key if no IP available
    return c.req.header("x-real-ip") || "unknown"
  },
  skip: () => false,
  onRateLimited: () => {},
}

export class RateLimiter {
  private store: Map<string, RateLimitEntry> = new Map()
  private config: Required<RateLimitConfig>
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    // Start cleanup interval to remove expired entries
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, this.config.windowMs)
  }

  private cleanup() {
    const now = Date.now()
    for (const [key, entry] of this.store.entries()) {
      if (now >= entry.resetTime) {
        this.store.delete(key)
      }
    }
  }

  public stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  public getStats() {
    const now = Date.now()
    let activeKeys = 0
    let totalRequests = 0

    for (const [, entry] of this.store.entries()) {
      if (now < entry.resetTime) {
        activeKeys++
        totalRequests += entry.count
      }
    }

    return {
      activeKeys,
      totalRequests,
      windowMs: this.config.windowMs,
      maxRequests: this.config.maxRequests,
    }
  }

  public middleware() {
    return async (c: Context, next: Next) => {
      // Skip if configured to skip
      if (this.config.skip(c)) {
        return next()
      }

      const key = this.config.keyGenerator(c)
      const now = Date.now()

      let entry = this.store.get(key)

      // Create new entry or reset if window expired
      if (!entry || now >= entry.resetTime) {
        entry = {
          count: 0,
          resetTime: now + this.config.windowMs,
        }
        this.store.set(key, entry)
      }

      // Increment request count
      entry.count++

      // Calculate remaining requests and reset time
      const remaining = Math.max(0, this.config.maxRequests - entry.count)
      const resetSeconds = Math.ceil((entry.resetTime - now) / 1000)

      // Set rate limit headers
      c.header("X-RateLimit-Limit", String(this.config.maxRequests))
      c.header("X-RateLimit-Remaining", String(remaining))
      c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetTime / 1000)))

      // Check if rate limited
      if (entry.count > this.config.maxRequests) {
        log.warn("rate limited", { key, count: entry.count, limit: this.config.maxRequests })

        this.config.onRateLimited(c)

        c.header("Retry-After", String(resetSeconds))

        return c.json(
          {
            error: "Too Many Requests",
            message: `Rate limit exceeded. Try again in ${resetSeconds} seconds.`,
            retryAfter: resetSeconds,
          },
          { status: 429 }
        )
      }

      return next()
    }
  }
}

// Create a default rate limiter instance
export const defaultRateLimiter = new RateLimiter()

// Export namespace for easy access to types and utilities
export namespace RateLimit {
  export type Config = RateLimitConfig
  export type Entry = RateLimitEntry

  // Pre-configured rate limiters for common use cases
  export const strict = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 30,
  })

  export const relaxed = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 300,
  })

  export const chatApi = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 60,
    skip: (c) => {
      // Skip rate limiting for health checks
      return c.req.path === "/health"
    },
  })
}
