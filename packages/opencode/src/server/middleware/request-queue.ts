import type { Context, Next } from "hono"
import { Log } from "../../util/log"

const log = Log.create({ service: "request-queue" })

interface QueuedRequest {
  id: string
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  enqueuedAt: number
}

interface RequestQueueConfig {
  maxConcurrent: number // Maximum concurrent requests
  maxQueueSize: number // Maximum requests waiting in queue
  timeoutMs: number // Timeout for queued requests
  onQueueFull?: () => void // Callback when queue is full
  onTimeout?: (requestId: string) => void // Callback when request times out
}

const DEFAULT_CONFIG: Required<RequestQueueConfig> = {
  maxConcurrent: 10,
  maxQueueSize: 100,
  timeoutMs: 30 * 1000, // 30 seconds
  onQueueFull: () => {},
  onTimeout: () => {},
}

export class RequestQueue {
  private queue: QueuedRequest[] = []
  private activeCount: number = 0
  private config: Required<RequestQueueConfig>
  private requestIdCounter: number = 0
  private totalProcessed: number = 0
  private totalRejected: number = 0
  private totalTimedOut: number = 0

  constructor(config: Partial<RequestQueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  private generateRequestId(): string {
    return `req-${Date.now()}-${++this.requestIdCounter}`
  }

  private processNext() {
    if (this.queue.length === 0 || this.activeCount >= this.config.maxConcurrent) {
      return
    }

    const request = this.queue.shift()
    if (request) {
      clearTimeout(request.timeout)
      this.activeCount++
      request.resolve()
    }
  }

  private async acquire(): Promise<void> {
    // If under limit, proceed immediately
    if (this.activeCount < this.config.maxConcurrent) {
      this.activeCount++
      return
    }

    // Check queue capacity
    if (this.queue.length >= this.config.maxQueueSize) {
      this.totalRejected++
      this.config.onQueueFull()
      throw new Error("Request queue full")
    }

    // Queue the request
    return new Promise<void>((resolve, reject) => {
      const requestId = this.generateRequestId()

      const timeout = setTimeout(() => {
        // Remove from queue on timeout
        const index = this.queue.findIndex((r) => r.id === requestId)
        if (index !== -1) {
          this.queue.splice(index, 1)
          this.totalTimedOut++
          this.config.onTimeout(requestId)
          reject(new Error("Request queue timeout"))
        }
      }, this.config.timeoutMs)

      this.queue.push({
        id: requestId,
        resolve,
        reject,
        timeout,
        enqueuedAt: Date.now(),
      })

      log.debug("request queued", {
        requestId,
        queueLength: this.queue.length,
        activeCount: this.activeCount,
      })
    })
  }

  private release() {
    this.activeCount--
    this.totalProcessed++
    this.processNext()
  }

  public getStats() {
    const queueWaitTimes = this.queue.map((r) => Date.now() - r.enqueuedAt)
    const avgWaitTime = queueWaitTimes.length > 0
      ? queueWaitTimes.reduce((a, b) => a + b, 0) / queueWaitTimes.length
      : 0

    return {
      activeCount: this.activeCount,
      queueLength: this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
      maxQueueSize: this.config.maxQueueSize,
      totalProcessed: this.totalProcessed,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut,
      avgWaitTimeMs: Math.round(avgWaitTime),
    }
  }

  public clear() {
    // Reject all queued requests
    for (const request of this.queue) {
      clearTimeout(request.timeout)
      request.reject(new Error("Queue cleared"))
    }
    this.queue = []
  }

  public middleware() {
    return async (c: Context, next: Next) => {
      try {
        await this.acquire()
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === "Request queue full") {
            log.warn("queue full", { queueLength: this.queue.length })
            return c.json(
              {
                error: "Service Unavailable",
                message: "Server is at capacity. Please try again later.",
              },
              { status: 503 }
            )
          }
          if (error.message === "Request queue timeout") {
            log.warn("queue timeout")
            return c.json(
              {
                error: "Gateway Timeout",
                message: "Request timed out waiting in queue.",
              },
              { status: 504 }
            )
          }
        }
        throw error
      }

      try {
        return await next()
      } finally {
        this.release()
      }
    }
  }
}

// Create a default request queue instance
export const defaultRequestQueue = new RequestQueue()

// Export namespace for easy access
export namespace Queue {
  export type Config = RequestQueueConfig
  export type Request = QueuedRequest

  // Pre-configured queues for common use cases
  export const chatQueue = new RequestQueue({
    maxConcurrent: 5, // Chat requests are expensive
    maxQueueSize: 50,
    timeoutMs: 60 * 1000, // 1 minute timeout
  })

  export const apiQueue = new RequestQueue({
    maxConcurrent: 20,
    maxQueueSize: 200,
    timeoutMs: 30 * 1000,
  })
}
