import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260710183215_unify_finny_persistence_root",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`task_run\` (
          \`id\` text PRIMARY KEY,
          \`parent_session_id\` text NOT NULL,
          \`description\` text NOT NULL,
          \`subagent_type\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`status\` text NOT NULL,
          \`started_at\` integer,
          \`finished_at\` integer,
          \`result_summary\` text,
          \`last_error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_task_run_id_session_id_fk\` FOREIGN KEY (\`id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_task_run_parent_session_id_session_id_fk\` FOREIGN KEY (\`parent_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`task_run_parent_idx\` ON \`task_run\` (\`parent_session_id\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`task_run_status_idx\` ON \`task_run\` (\`status\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
