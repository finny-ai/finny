import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
import { Workspace } from "../../control-plane/workspace"
import { Project } from "../../project/project"
import { Installation } from "../../installation"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = await Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

    let workspaceSync: Array<Awaited<ReturnType<typeof Workspace.startSyncing>>> = []
    // Only available in development right now
    if (Installation.isLocal()) {
      const projects = await Project.list()
      workspaceSync = await Promise.all(projects.map((project: Project.Info) => Workspace.startSyncing(project)))
    }

    await new Promise(() => {})
    await server.stop()
  },
})
