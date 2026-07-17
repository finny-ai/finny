import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260709193631_algorithm_build_workflow",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`algorithm_build_approval_challenge\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`scope_hash\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`status\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`source_message_id\` text,
          \`resolved_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_algorithm_build_approval_challenge_workflow_id_algorithm_build_workflow_id_fk\` FOREIGN KEY (\`workflow_id\`) REFERENCES \`algorithm_build_workflow\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`algorithm_build_workflow_event\` (
          \`id\` text PRIMARY KEY,
          \`workflow_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`source_kind\` text NOT NULL,
          \`source_message_id\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_algorithm_build_workflow_event_workflow_id_algorithm_build_workflow_id_fk\` FOREIGN KEY (\`workflow_id\`) REFERENCES \`algorithm_build_workflow\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`algorithm_build_workflow\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`workspace_slug\` text NOT NULL,
          \`stage\` text NOT NULL,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`algorithm_build_approval_workflow_status_idx\` ON \`algorithm_build_approval_challenge\` (\`workflow_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`algorithm_build_approval_scope_idx\` ON \`algorithm_build_approval_challenge\` (\`workflow_id\`,\`kind\`,\`scope_hash\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`algorithm_build_workflow_event_seq_idx\` ON \`algorithm_build_workflow_event\` (\`workflow_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`algorithm_build_workflow_event_type_idx\` ON \`algorithm_build_workflow_event\` (\`workflow_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`algorithm_build_workflow_session_idx\` ON \`algorithm_build_workflow\` (\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`algorithm_build_workflow_workspace_idx\` ON \`algorithm_build_workflow\` (\`workspace_slug\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
