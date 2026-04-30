import type { Argv } from "yargs"
import { EOL } from "os"
import { cmd } from "./cmd"
import { CronStorage, Schedule, Scheduler, Notify, Job } from "../../cron"
import { Autostart } from "../../cron/autostart-macos"
import { UI } from "../ui"

function fmtJob(job: Job.Schema): string {
  const status = job.enabled ? "on" : "off"
  const last = job.lastRunAt ? new Date(job.lastRunAt).toISOString() : "—"
  const fired = job.lastFiredAt ? new Date(job.lastFiredAt).toISOString() : "—"
  const tag = job.kind === "check" ? `check:${job.check?.type}${job.check?.symbol ? " " + job.check?.symbol : ""}` : "prompt"
  return [
    `${job.id}  [${status}]  ${job.name}`,
    `    ${tag}  ·  ${job.scheduleSource}  (${job.schedule})${job.marketAware ? "  market-aware" : ""}`,
    `    last run: ${last}   last fired: ${fired}   failures: ${job.failureCount}`,
    job.lastError ? `    last error: ${job.lastError}` : "",
  ]
    .filter(Boolean)
    .join(EOL)
}

const AddCommand = cmd({
  command: "add",
  describe: "add a scheduled job",
  builder: (yargs: Argv) =>
    yargs
      .option("name", { type: "string", describe: "human label for the job", demandOption: true })
      .option("schedule", {
        type: "string",
        describe: "cron expression or @market_open/@market_close/@pre_market/@after_hours",
        demandOption: true,
      })
      .option("timezone", { type: "string", default: "America/New_York" })
      .option("prompt", { type: "string", describe: "agent prompt to run on the schedule (prompt job)" })
      .option("agent", { type: "string", describe: "agent to use for prompt jobs" })
      .option("check-type", { type: "string", choices: ["price", "pnl", "position"] as const })
      .option("symbol", { type: "string" })
      .option("op", { type: "string", choices: [">", "<", ">=", "<=", "%change"] as const })
      .option("value", { type: "number" })
      .option("cooldown-minutes", { type: "number", default: 60 })
      .option("notify-title", { type: "string" })
      .option("notify-body", { type: "string" }),
  async handler(args) {
    const parsed = Schedule.parse(args.schedule, args.timezone)

    const isCheck = !!args["check-type"]
    if (!isCheck && !args.prompt) {
      UI.error("specify either --prompt or --check-type with --op and --value")
      process.exit(1)
    }
    if (isCheck && (!args.op || args.value === undefined)) {
      UI.error("--check-type requires --op and --value")
      process.exit(1)
    }

    const job = await CronStorage.create({
      name: args.name,
      kind: isCheck ? "check" : "prompt",
      schedule: parsed.cron,
      scheduleSource: args.schedule,
      marketAware: parsed.marketAware,
      timezone: parsed.timezone,
      enabled: true,
      check: isCheck
        ? {
            type: args["check-type"]! as Job.CheckType,
            symbol: args.symbol,
            op: args.op! as Job.CheckOp,
            value: args.value!,
            cooldownMinutes: args["cooldown-minutes"],
          }
        : undefined,
      prompt: !isCheck ? { text: args.prompt!, agent: args.agent } : undefined,
      notification: { title: args["notify-title"], body: args["notify-body"] },
    } as any)

    process.stdout.write(`created ${job.id}${EOL}`)
    process.stdout.write(fmtJob(job) + EOL)

    if (process.platform === "darwin" && !(await Autostart.isInstalled())) {
      process.stdout.write(EOL)
      process.stdout.write(
        "Note: the background helper is not installed yet. Run `finny cron install-autostart` to" + EOL,
      )
      process.stdout.write("enable jobs to fire when Finny is closed." + EOL)
    }
  },
})

const ListCommand = cmd({
  command: "list",
  describe: "list all cron jobs",
  async handler() {
    const jobs = await CronStorage.list()
    if (jobs.length === 0) {
      process.stdout.write("no jobs. add one with `finny cron add --name ... --schedule ... --prompt ...`" + EOL)
      return
    }
    for (const j of jobs) {
      process.stdout.write(fmtJob(j) + EOL + EOL)
    }
  },
})

const RemoveCommand = cmd({
  command: "remove <id>",
  describe: "remove a cron job",
  builder: (yargs: Argv) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(args) {
    const ok = await CronStorage.remove(args.id as string)
    if (!ok) {
      UI.error(`no job with id ${args.id}`)
      process.exit(1)
    }
    process.stdout.write(`removed ${args.id}${EOL}`)
  },
})

const PauseCommand = cmd({
  command: "pause <id>",
  describe: "disable a cron job",
  builder: (yargs: Argv) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(args) {
    const job = await CronStorage.update(args.id as string, { enabled: false })
    if (!job) {
      UI.error(`no job with id ${args.id}`)
      process.exit(1)
    }
    process.stdout.write(`paused ${job.id}${EOL}`)
  },
})

const ResumeCommand = cmd({
  command: "resume <id>",
  describe: "re-enable a cron job",
  builder: (yargs: Argv) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(args) {
    const job = await CronStorage.update(args.id as string, { enabled: true, failureCount: 0, lastError: undefined })
    if (!job) {
      UI.error(`no job with id ${args.id}`)
      process.exit(1)
    }
    process.stdout.write(`resumed ${job.id}${EOL}`)
  },
})

const RunCommand = cmd({
  command: "run <id>",
  describe: "fire a job once now (for testing)",
  builder: (yargs: Argv) => yargs.positional("id", { type: "string", demandOption: true }),
  async handler(args) {
    const record = await Scheduler.runOnce(args.id as string)
    process.stdout.write(JSON.stringify(record, null, 2) + EOL)
  },
})

const LogsCommand = cmd({
  command: "logs <id>",
  describe: "show recent runs of a job",
  builder: (yargs: Argv) =>
    yargs
      .positional("id", { type: "string", demandOption: true })
      .option("n", { type: "number", default: 25, describe: "how many runs to show" }),
  async handler(args) {
    const runs = await CronStorage.tailRuns(args.id as string, args.n)
    if (runs.length === 0) {
      process.stdout.write("no runs yet" + EOL)
      return
    }
    for (const r of runs) {
      process.stdout.write(
        `${new Date(r.startedAt).toISOString()}  ${r.status.padEnd(8)}  ${r.durationMs}ms  ${r.note ?? ""}` + EOL,
      )
    }
  },
})

const InstallAutostartCommand = cmd({
  command: "install-autostart",
  describe: "install the background helper (macOS launchd) so jobs fire when Finny is closed",
  builder: (yargs: Argv) =>
    yargs.option("exec", {
      type: "string",
      describe: "absolute path to the finny binary (auto-detected; override for non-default installs)",
    }),
  async handler(args) {
    if (process.platform !== "darwin") {
      UI.error("autostart is macOS-only in v1")
      process.exit(1)
    }
    const result = await Autostart.install(args.exec)
    process.stdout.write(`installed ${result.path}${EOL}`)
    process.stdout.write(`working directory: ${result.workingDirectory}${EOL}`)
    process.stdout.write("Command launchd will run:" + EOL)
    for (const a of result.programArguments) process.stdout.write(`  ${a}${EOL}`)
    process.stdout.write("Daemon is now running and will restart on login." + EOL)
  },
})

const UninstallAutostartCommand = cmd({
  command: "uninstall-autostart",
  describe: "remove the background helper",
  async handler() {
    if (process.platform !== "darwin") {
      UI.error("autostart is macOS-only in v1")
      process.exit(1)
    }
    const removed = await Autostart.uninstall()
    process.stdout.write(removed ? "uninstalled" + EOL : "no autostart was installed" + EOL)
  },
})

const TestNotifyCommand = cmd({
  command: "test-notify",
  describe: "send a test macOS notification (verifies osascript permissions)",
  async handler() {
    await Notify.send({ title: "Finny", body: "test notification — wiring works." })
    process.stdout.write("sent" + EOL)
  },
})

export const CronCommand = cmd({
  command: "cron",
  describe: "manage scheduled jobs",
  builder: (yargs) =>
    yargs
      .command(AddCommand)
      .command(ListCommand)
      .command(RemoveCommand)
      .command(PauseCommand)
      .command(ResumeCommand)
      .command(RunCommand)
      .command(LogsCommand)
      .command(InstallAutostartCommand)
      .command(UninstallAutostartCommand)
      .command(TestNotifyCommand)
      .demandCommand(),
  async handler() {},
})
