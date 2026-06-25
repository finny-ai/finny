import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) =>
    withNetworkOptions(yargs).option("daemon", {
      type: "boolean",
      default: false,
      describe: "publish a discovery file so the TUI can auto-attach; cleaned up on exit",
    }),
  describe: "starts a headless Finny server",
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    const { License } = yield* Effect.promise(() => import("@/license"))
    if (!process.env["FINNY_SERVER_PASSWORD"] && !Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: FINNY_SERVER_PASSWORD is not set; server is unsecured.")
    }
    if (process.env.FINNY_LICENSE_KEY?.trim()) {
      yield* Effect.promise(() => License.ensureActive())
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(`finny server listening on http://${server.hostname}:${server.port}`)

    if (args.daemon) {
      const { Daemon } = yield* Effect.promise(() => import("../daemon"))
      // Imported eagerly here so the exit/signal handlers below can terminate
      // workers synchronously without a (disallowed) async import at exit time.
      const { LiveRunner } = yield* Effect.promise(() => import("@/live/runner"))
      yield* Effect.promise(() => Daemon.writeInfo(Daemon.infoForServer(server)))
      // On shutdown, stop the live worker children before exiting — Node does
      // not tear down spawned children, so an orphaned worker would keep
      // submitting orders with no registry entry or UI stop path. Then remove
      // the discovery file so a stale entry doesn't point the TUI at a dead
      // process.
      const cleanup = () => {
        try {
          LiveRunner.killAllSync()
        } catch {
          // best effort — never block discovery-file cleanup or exit
        }
        Daemon.clearInfoSync()
      }
      process.once("exit", cleanup)
      process.once("SIGINT", () => {
        cleanup()
        process.exit(0)
      })
      process.once("SIGTERM", () => {
        cleanup()
        process.exit(0)
      })
    }

    yield* Effect.never
  }),
})
