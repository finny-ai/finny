import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260710183538_storage_root_marker",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`storage_root_migration\` (
          \`id\` text PRIMARY KEY,
          \`source_path\` text NOT NULL,
          \`target_path\` text NOT NULL,
          \`source_backup\` text NOT NULL,
          \`target_backup\` text NOT NULL,
          \`time_completed\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
