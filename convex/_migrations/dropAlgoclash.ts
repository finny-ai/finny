import { internalMutation } from "../_generated/server"

const TABLES = [
  "algoclashUsers",
  "algoclashAlgorithms",
  "algoclashTrades",
  "algoclashPortfolios",
  "algoclashLeaderboard",
] as const

export const purgeAlgoclashTables = internalMutation({
  args: {},
  handler: async (ctx) => {
    const counts: Record<string, number> = {}
    for (const table of TABLES) {
      let total = 0
      let batch = await ctx.db.query(table as any).take(500)
      while (batch.length > 0) {
        for (const row of batch) {
          await ctx.db.delete(row._id)
          total++
        }
        batch = await ctx.db.query(table as any).take(500)
      }
      counts[table] = total
    }
    return counts
  },
})
