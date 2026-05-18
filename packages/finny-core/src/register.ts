import { Registry } from "@finny-ai/registry"
import { audit } from "./tools/audit"
import { discord } from "./tools/discord"
import { market } from "./tools/market"
import { orders } from "./tools/orders"
import { portfolio } from "./tools/portfolio"
import { researcher } from "./tools/researcher"
import { write } from "./policy"

export function register() {
  Registry.tools.register({ id: "finny_market_query", def: market })
  Registry.tools.register({ id: "finny_portfolio_get", def: portfolio })
  Registry.tools.register({ id: "finny_orders_create", def: orders })
  Registry.tools.register({ id: "finny_audit_log", def: audit })
  Registry.tools.register({ id: "finny_discord_read", def: discord })
  Registry.tools.register({ id: "finny_research_dispatch", def: researcher })
  Registry.policies.register({ id: "finny_write_gate", check: write })
}
