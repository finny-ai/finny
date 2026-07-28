import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260728012323_fund_case_store",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`fund_case_child\` (
          \`child_session_id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`manager_session_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`attempt_no\` integer NOT NULL,
          \`draft_sha256\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_fund_case_child_case_id_fund_case_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`fund_case\`(\`case_id\`) ON DELETE RESTRICT,
          CONSTRAINT "fund_case_child_attempt_range" CHECK("attempt_no" BETWEEN 1 AND 2)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`fund_case_draft\` (
          \`draft_id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`event_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`payload_json\` text NOT NULL,
          \`draft_sha256\` text NOT NULL,
          \`risk_tier\` text NOT NULL,
          \`human_approval_required\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_fund_case_draft_case_id_fund_case_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`fund_case\`(\`case_id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`fund_case_proposal\` (
          \`proposal_id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`event_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`payload_json\` text NOT NULL,
          \`proposal_sha256\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`risk_tier\` text NOT NULL,
          \`human_approval_required\` integer NOT NULL,
          \`gateway_review\` text NOT NULL,
          \`execution_authorized\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_fund_case_proposal_case_id_fund_case_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`fund_case\`(\`case_id\`) ON DELETE RESTRICT,
          CONSTRAINT "fund_case_proposal_never_executable" CHECK("execution_authorized" = 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`fund_case_report_admission\` (
          \`attestation_id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`submission_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`report_sha256\` text NOT NULL,
          \`admitted_at\` integer NOT NULL,
          CONSTRAINT \`fk_fund_case_report_admission_case_id_fund_case_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`fund_case\`(\`case_id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_fund_case_report_admission_submission_id_fund_case_report_submission_submission_id_fk\` FOREIGN KEY (\`submission_id\`) REFERENCES \`fund_case_report_submission\`(\`submission_id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_fund_case_report_admission_child_session_id_fund_case_child_child_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`fund_case_child\`(\`child_session_id\`) ON DELETE RESTRICT
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`fund_case_report_submission\` (
          \`submission_id\` text PRIMARY KEY,
          \`case_id\` text NOT NULL,
          \`manager_session_id\` text NOT NULL,
          \`child_session_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`subject\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`recommendation\` text NOT NULL,
          \`confidence\` real NOT NULL,
          \`evidence_json\` text NOT NULL,
          \`evidence_sha256\` text NOT NULL,
          \`risk_flags_json\` text NOT NULL,
          \`draft_sha256\` text,
          \`report_sha256\` text NOT NULL,
          \`submitted_at\` integer NOT NULL,
          CONSTRAINT \`fk_fund_case_report_submission_case_id_fund_case_case_id_fk\` FOREIGN KEY (\`case_id\`) REFERENCES \`fund_case\`(\`case_id\`) ON DELETE RESTRICT,
          CONSTRAINT \`fk_fund_case_report_submission_child_session_id_fund_case_child_child_session_id_fk\` FOREIGN KEY (\`child_session_id\`) REFERENCES \`fund_case_child\`(\`child_session_id\`) ON DELETE RESTRICT,
          CONSTRAINT "fund_case_report_confidence_range" CHECK("confidence" BETWEEN 0 AND 1)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`fund_case\` (
          \`case_id\` text PRIMARY KEY,
          \`manager_session_id\` text NOT NULL,
          \`trigger_message_id\` text NOT NULL,
          \`event_id\` text NOT NULL,
          \`event_type\` text NOT NULL,
          \`source_event_ref\` text NOT NULL,
          \`event_sha256\` text NOT NULL,
          \`evidence_json\` text NOT NULL,
          \`evidence_sha256\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_child_role_attempt_idx\` ON \`fund_case_child\` (\`case_id\`,\`role\`,\`attempt_no\`);`)
      yield* tx.run(`CREATE INDEX \`fund_case_child_case_idx\` ON \`fund_case_child\` (\`case_id\`,\`time_created\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_draft_case_idx\` ON \`fund_case_draft\` (\`case_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_draft_event_idx\` ON \`fund_case_draft\` (\`event_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_draft_sha_idx\` ON \`fund_case_draft\` (\`draft_sha256\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_proposal_case_idx\` ON \`fund_case_proposal\` (\`case_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_proposal_event_idx\` ON \`fund_case_proposal\` (\`event_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_proposal_sha_idx\` ON \`fund_case_proposal\` (\`proposal_sha256\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_proposal_idempotency_idx\` ON \`fund_case_proposal\` (\`idempotency_key\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_report_admission_submission_idx\` ON \`fund_case_report_admission\` (\`submission_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_report_admission_child_idx\` ON \`fund_case_report_admission\` (\`child_session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_report_admission_sha_idx\` ON \`fund_case_report_admission\` (\`report_sha256\`);`)
      yield* tx.run(`CREATE INDEX \`fund_case_report_admission_case_role_idx\` ON \`fund_case_report_admission\` (\`case_id\`,\`role\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_report_child_idx\` ON \`fund_case_report_submission\` (\`child_session_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_report_sha_idx\` ON \`fund_case_report_submission\` (\`report_sha256\`);`)
      yield* tx.run(`CREATE INDEX \`fund_case_report_case_role_idx\` ON \`fund_case_report_submission\` (\`case_id\`,\`role\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_trigger_message_idx\` ON \`fund_case\` (\`trigger_message_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_event_id_idx\` ON \`fund_case\` (\`event_id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`fund_case_idempotency_idx\` ON \`fund_case\` (\`idempotency_key\`);`)
      yield* tx.run(`CREATE INDEX \`fund_case_manager_time_idx\` ON \`fund_case\` (\`manager_session_id\`,\`time_created\`);`)
      for (const table of [
        "fund_case",
        "fund_case_child",
        "fund_case_report_submission",
        "fund_case_report_admission",
        "fund_case_draft",
        "fund_case_proposal",
      ]) {
        yield* tx.run(
          `CREATE TRIGGER \`${table}_reject_update\`
           BEFORE UPDATE ON \`${table}\`
           BEGIN
             SELECT RAISE(ABORT, '${table} is append-only');
           END;`,
        )
        yield* tx.run(
          `CREATE TRIGGER \`${table}_reject_delete\`
           BEFORE DELETE ON \`${table}\`
           BEGIN
             SELECT RAISE(ABORT, '${table} is append-only');
           END;`,
        )
      }
    })
  },
} satisfies DatabaseMigration.Migration
