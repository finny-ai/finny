import z from "zod"
import { Effect } from "effect"
import path from "path"
import os from "os"
import { promises as fs } from "fs"
import { Tool } from "./tool"
import { Algorithm } from "../algorithm"

const parameters = z
  .object({
    name: z.string().optional().describe("The algorithm name (preferred)."),
    algorithmId: z.string().optional().describe("Alternative: the lineage UUID."),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The version to export. Defaults to the latest version. Use finny_algorithm_versions to discover versions."),
    destPath: z
      .string()
      .describe(
        "Absolute path to write the strategy file to (e.g. /Users/me/Documents/strategy-v3.py). Tilde (~) is expanded. Parent directories must already exist.",
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe("If a file exists at destPath, set true to replace it. Defaults to false (the call fails)."),
  })
  .refine((v) => !!v.name || !!v.algorithmId, {
    message: "Provide either name or algorithmId.",
  })

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(1))
  return p
}

export const AlgorithmExportTool = Tool.define(
  "finny_algorithm_export",
  Effect.succeed({
    description:
      "Export a saved algorithm version to a file on disk. ALWAYS use this tool — never use the generic `write` tool to export a strategy (the write tool is subject to per-agent permission rules that may block .py writes; this tool is not). Defaults to the latest version unless `version` is specified.",
    parameters,
    execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
      Effect.promise(async (): Promise<Tool.ExecuteResult> => {
        // Validate absoluteness on the EXPANDED path (after `~` substitution
        // but before resolve). path.resolve() always returns an absolute path
        // by prefixing process.cwd(), so checking after resolve would silently
        // accept relative paths and write them to wherever Finny was started.
        const expanded = expandHome(params.destPath)
        if (!path.isAbsolute(expanded)) {
          return {
            title: "Bad destPath",
            output: `destPath must be absolute (got "${params.destPath}"). Use an absolute path like /Users/you/Documents/strategy.py or ~/Documents/strategy.py.`,
            metadata: { blocked: true },
          }
        }
        const destPath = path.resolve(expanded)

        await ctx.ask({
          permission: "finny_algorithm_export",
          patterns: [destPath],
          always: ["*"],
          metadata: { destPath },
        })

        // Resolve algorithmId from name if needed; pick version row.
        let algo: Algorithm.Info | null = null
        let algorithmId = params.algorithmId
        if (!algorithmId && params.name) {
          const latest = await Algorithm.get(params.name)
          if (!latest) {
            return {
              title: "Not found",
              output: `No algorithm found with name "${params.name}".`,
              metadata: { blocked: true },
            }
          }
          algorithmId = latest.algorithmId
          if (!params.version || params.version === latest.version) algo = latest
        }
        if (!algorithmId) {
          return {
            title: "Bad input",
            output: "Provide either name or algorithmId.",
            metadata: { blocked: true },
          }
        }

        if (!algo) {
          if (params.version != null) {
            algo = await Algorithm.getVersion(algorithmId, params.version)
            if (!algo) {
              return {
                title: "Version not found",
                output: `algorithmId ${algorithmId} has no version ${params.version}. Use finny_algorithm_versions to list available versions.`,
                metadata: { blocked: true, algorithmId },
              }
            }
          } else {
            // No version requested → latest.
            const versions = await Algorithm.listVersions(algorithmId)
            if (versions.length === 0) {
              return {
                title: "No versions",
                output: `algorithmId ${algorithmId} has no versions saved.`,
                metadata: { blocked: true, algorithmId },
              }
            }
            algo = versions[0] // listVersions returns newest first
          }
        }

        // Existence guard.
        const exists = await fs
          .stat(destPath)
          .then(() => true)
          .catch(() => false)
        if (exists && !params.overwrite) {
          return {
            title: "Refusing to overwrite",
            output: `${destPath} already exists. Pass overwrite: true to replace it.`,
            metadata: { blocked: true, destPath, exists: true },
          }
        }

        try {
          await fs.writeFile(destPath, algo.code, "utf8")
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            title: "Write failed",
            output: `Failed to write ${destPath}: ${msg}`,
            metadata: { blocked: true, destPath, error: msg },
          }
        }

        const bytes = Buffer.byteLength(algo.code, "utf8")
        return {
          title: `Exported ${algo.name} v${algo.version}`,
          output: `Wrote ${bytes} bytes to ${destPath}.`,
          metadata: {
            algorithmId: algo.algorithmId,
            name: algo.name,
            version: algo.version,
            destPath,
            bytes,
            overwritten: exists,
          },
        }
      }),
  }),
)
