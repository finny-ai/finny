import z from "zod"

export namespace Job {
  export const Kind = z.enum(["check", "prompt"])
  export type Kind = z.infer<typeof Kind>

  export const CheckType = z.enum(["price", "pnl", "position"])
  export type CheckType = z.infer<typeof CheckType>

  export const CheckOp = z.enum([">", "<", ">=", "<=", "%change"])
  export type CheckOp = z.infer<typeof CheckOp>

  export const Check = z.object({
    type: CheckType,
    symbol: z.string().optional(),
    op: CheckOp,
    value: z.number(),
    cooldownMinutes: z.number().int().nonnegative().default(60),
    escalatePrompt: z.string().optional(),
  })
  export type Check = z.infer<typeof Check>

  export const Prompt = z.object({
    text: z.string().min(1),
    agent: z.string().optional(),
    model: z.string().optional(),
  })
  export type Prompt = z.infer<typeof Prompt>

  export const Notification = z.object({
    title: z.string().optional(),
    body: z.string().optional(),
  })
  export type Notification = z.infer<typeof Notification>

  export const Schema = z.object({
    id: z.string(),
    name: z.string().min(1),
    kind: Kind,
    schedule: z.string().min(1),
    scheduleSource: z.string(),
    marketAware: z.boolean().default(false),
    timezone: z.string().default("America/New_York"),
    enabled: z.boolean().default(true),
    createdAt: z.number().int(),
    lastRunAt: z.number().int().optional(),
    lastFiredAt: z.number().int().optional(),
    lastError: z.string().optional(),
    failureCount: z.number().int().nonnegative().default(0),
    check: Check.optional(),
    prompt: Prompt.optional(),
    notification: Notification.default({}),
  })
  export type Schema = z.infer<typeof Schema>
}
