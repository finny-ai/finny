import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"
import { Scheduler } from "../../cron"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("scheduler", {
      type: "boolean",
      describe: "run the cron scheduler inside this serve process",
      default: false,
    }),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = await Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    if (args.scheduler) {
      Scheduler.start()
      console.log("cron scheduler running (1m tick)")
    }

    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      if (args.scheduler) Scheduler.stop()
      await server.stop()
      process.exit(0)
    }
    // process.on doesn't await async listeners. Wrap so any rejection from
    // server.stop() is logged instead of becoming an unhandled rejection,
    // and so a second signal during shutdown is a no-op.
    const handleSignal = () => {
      void stop().catch((err) => {
        console.error("shutdown error:", err)
        process.exit(1)
      })
    }
    process.on("SIGINT", handleSignal)
    process.on("SIGTERM", handleSignal)

    await new Promise(() => {})
  },
})
