import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { UI } from "../ui"

const InfoCommand = cmd({
  command: "$0",
  describe: "show database info",
  handler: async () => {
    const url = process.env.CONVEX_URL ?? "(not set)"
    UI.println(`Database: Convex`)
    UI.println(`CONVEX_URL: ${url}`)
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs.command(InfoCommand).demandCommand()
  },
  handler: () => {},
})
