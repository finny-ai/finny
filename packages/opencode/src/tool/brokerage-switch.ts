import path from "path"
import z from "zod"
import { Effect } from "effect"
import { Tool } from "./tool"
import { BrokerRegistry, type BrokerKind } from "@/live/brokers"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"

const BROKERAGE_STATE_FILE = path.join(Global.Path.state, "brokerage.json")

function isRegisteredBrokerKind(value: string): value is BrokerKind {
  return BrokerRegistry.specs().some((s) => s.kind === value)
}

const parameters = z.object({
  kind: z
    .string()
    .trim()
    .refine(isRegisteredBrokerKind, {
      message: `Brokerage must be one of: ${BrokerRegistry.specs()
        .map((s) => s.kind)
        .join(", ")}`,
    })
    .describe("Brokerage to switch to. Must be one of the registered BrokerKinds."),
  reason: z
    .string()
    .trim()
    .min(1)
    .describe(
      "One sentence the user will see explaining why you're switching. Example: " +
        "'AAPL is a US equity but your brokerage is Binance — switching to Alpaca.'",
    ),
})

const DESCRIPTION = [
  "Switch the user's ACTIVE brokerage. Use this when the user's request doesn't fit the currently-active brokerage's asset class — e.g. they ask for an equity strategy while Binance is active, or a crypto-only pair while IBKR equities is active.",
  "",
  "RULES — read all before calling:",
  "1. Only call this when there is a clear asset-class mismatch the user almost certainly wants resolved. Don't switch for stylistic reasons.",
  "2. The target brokerage must already have at least one connected account. If `listAccounts(target)` is empty, this tool refuses — and you must instead tell the user to add an account via Settings → Brokerages.",
  "3. Announce the switch in chat BEFORE calling. The user should never see the brokerage change without knowing why.",
  "4. After a successful switch, proceed with the build. The agent's next system-prompt rebuild will see the new brokerage's symbol convention / asset rules automatically — no extra step.",
  "5. Do NOT call this just to silence a refusal. If the user genuinely wants to trade something the current brokerage doesn't support and a different brokerage does, switch. If no brokerage supports the request (e.g. FX spot or non-US instruments), refuse outright.",
  "",
  "On success the tool returns the new brokerage's displayName. The TUI Brokerage capsule updates within ~1s.",
].join("\n")

export const BrokerageSwitchTool = Tool.define(
  "finny_brokerage_switch",
  Effect.succeed({
    description: DESCRIPTION,
    parameters,
    execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> => {
        await ctx.ask({
          permission: "finny_brokerage_switch",
          patterns: ["*"],
          always: ["*"],
          metadata: { kind: input.kind, reason: input.reason },
        })

        const spec = BrokerRegistry.specs().find((s) => s.kind === input.kind)
        if (!spec) {
          return {
            title: "Unknown brokerage",
            output: `No brokerage registered with kind "${input.kind}". Registered kinds: ${BrokerRegistry.specs()
              .map((s) => s.kind)
              .join(", ")}.`,
            metadata: { switched: false, kind: input.kind },
          }
        }
        const target = spec.kind

        const accounts = await BrokerRegistry.listAccounts(target)
        if (accounts.length === 0) {
          return {
            title: `No ${spec.displayName} account`,
            output: [
              `The user has no ${spec.displayName} account connected, so switching would leave them unable to run or backtest the strategy.`,
              `Tell the user to add a ${spec.displayName} account via Settings → Brokerages, then ask them to retry.`,
            ].join(" "),
            metadata: { switched: false, kind: target, reason: "no_account" },
          }
        }

        // Preserve any other fields already in the file (e.g. `recent`).
        let prior: Record<string, unknown> = {}
        try {
          const raw = await Filesystem.readJson(BROKERAGE_STATE_FILE)
          if (raw && typeof raw === "object") prior = raw as Record<string, unknown>
        } catch {
          // First-time write — fine.
        }

        const prevRecent = Array.isArray(prior.recent) ? (prior.recent as string[]).filter((k) => k !== target) : []
        const nextRecent = [target, ...prevRecent].slice(0, 10)

        await Filesystem.writeJson(BROKERAGE_STATE_FILE, {
          ...prior,
          current: target,
          recent: nextRecent,
        })

        return {
          title: `Switched to ${spec.displayName}`,
          output: [
            `Active brokerage is now ${spec.displayName}.`,
            `Reason given: ${input.reason}`,
            `Subsequent strategy code will follow ${spec.displayName} conventions automatically.`,
          ].join("\n"),
          metadata: {
            switched: true,
            kind: target,
            displayName: spec.displayName,
            accountCount: accounts.length,
            reason: input.reason,
          },
        }
      }),
  }),
)
