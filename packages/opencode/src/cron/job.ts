import z from "zod"

export namespace Job {
  export const Kind = z.enum(["check", "prompt"])
  export type Kind = z.infer<typeof Kind>

  export const CheckType = z.enum(["price", "pnl", "position"])
  export type CheckType = z.infer<typeof CheckType>

  // %change is meaningful for price and pnl (compares percent against threshold).
  // For raw position quantity it is meaningless, so the position check below
  // narrows to absolute comparators only.
  export const CheckOp = z.enum([">", "<", ">=", "<=", "%change"])
  export type CheckOp = z.infer<typeof CheckOp>
  const PositionOp = z.enum([">", "<", ">=", "<="])

  const PriceCheck = z.object({
    type: z.literal("price"),
    symbol: z.string().min(1),
    op: CheckOp,
    value: z.number(),
    cooldownMinutes: z.number().int().nonnegative().default(60),
    escalatePrompt: z.string().optional(),
  })
  const PnlCheck = z.object({
    type: z.literal("pnl"),
    op: CheckOp,
    value: z.number(),
    cooldownMinutes: z.number().int().nonnegative().default(60),
    escalatePrompt: z.string().optional(),
  })
  const PositionCheck = z.object({
    type: z.literal("position"),
    symbol: z.string().min(1),
    op: PositionOp,
    value: z.number(),
    cooldownMinutes: z.number().int().nonnegative().default(60),
    escalatePrompt: z.string().optional(),
  })
  export const Check = z.discriminatedUnion("type", [PriceCheck, PnlCheck, PositionCheck])
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

  // Common fields that exist on every job kind. Kept private — callers
  // construct values through the discriminated union schemas below.
  const Common = z.object({
    id: z.string(),
    name: z.string().min(1),
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
    notification: Notification.default({}),
  })

  const CheckJob = Common.extend({
    kind: z.literal("check"),
    check: Check,
  })
  const PromptJob = Common.extend({
    kind: z.literal("prompt"),
    prompt: Prompt,
  })

  // Stored job, fully validated (id/createdAt/failureCount required).
  export const Schema = z.discriminatedUnion("kind", [CheckJob, PromptJob])
  export type Schema = z.infer<typeof Schema>

  // Caller-facing creation shape — id/createdAt/failureCount are populated by
  // CronStorage.create, so callers leave them out. This replaces the old
  // `as any` cast at the CLI layer.
  export const Input = z.discriminatedUnion("kind", [
    CheckJob.omit({ id: true, createdAt: true, failureCount: true }),
    PromptJob.omit({ id: true, createdAt: true, failureCount: true }),
  ])
  export type Input = z.input<typeof Input>
}
