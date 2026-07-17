import { EOL } from "os"
import { PackagedBacktestSmoke } from "@/backtest/packaged-smoke"
import { cmd } from "../cmd"

export const EngineSmokeCommand = cmd({
  command: "engine-smoke",
  describe: false,
  builder: (yargs) =>
    yargs
      .option("python", { type: "string", describe: "Python interpreter with the locked engine dependencies" })
      .option("keep", { type: "boolean", default: false, describe: "Keep the temporary smoke directory" }),
  async handler(args) {
    const result = await PackagedBacktestSmoke.run({ python: args.python, keep: args.keep })
    process.stdout.write(`${JSON.stringify(result)}${EOL}`)
  },
})
