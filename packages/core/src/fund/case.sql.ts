import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const FundCaseTable = sqliteTable(
  "fund_case",
  {
    case_id: text().primaryKey(),
    manager_session_id: text().notNull(),
    trigger_message_id: text().notNull(),
    event_id: text().notNull(),
    event_type: text().notNull(),
    source_event_ref: text().notNull(),
    event_sha256: text().notNull(),
    evidence_json: text().notNull(),
    evidence_sha256: text().notNull(),
    idempotency_key: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("fund_case_trigger_message_idx").on(table.trigger_message_id),
    uniqueIndex("fund_case_event_id_idx").on(table.event_id),
    uniqueIndex("fund_case_idempotency_idx").on(table.idempotency_key),
    index("fund_case_manager_time_idx").on(table.manager_session_id, table.time_created),
  ],
)

export const FundCaseChildTable = sqliteTable(
  "fund_case_child",
  {
    child_session_id: text().primaryKey(),
    case_id: text()
      .notNull()
      .references(() => FundCaseTable.case_id, { onDelete: "restrict" }),
    manager_session_id: text().notNull(),
    role: text().notNull(),
    attempt_no: integer().notNull(),
    draft_sha256: text(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("fund_case_child_role_attempt_idx").on(table.case_id, table.role, table.attempt_no),
    index("fund_case_child_case_idx").on(table.case_id, table.time_created),
    check("fund_case_child_attempt_range", sql`${table.attempt_no} BETWEEN 1 AND 2`),
  ],
)

export const FundCaseReportSubmissionTable = sqliteTable(
  "fund_case_report_submission",
  {
    submission_id: text().primaryKey(),
    case_id: text()
      .notNull()
      .references(() => FundCaseTable.case_id, { onDelete: "restrict" }),
    manager_session_id: text().notNull(),
    child_session_id: text()
      .notNull()
      .references(() => FundCaseChildTable.child_session_id, { onDelete: "restrict" }),
    role: text().notNull(),
    subject: text().notNull(),
    summary: text().notNull(),
    recommendation: text().notNull(),
    confidence: real().notNull(),
    evidence_json: text().notNull(),
    evidence_sha256: text().notNull(),
    risk_flags_json: text().notNull(),
    draft_sha256: text(),
    report_sha256: text().notNull(),
    submitted_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("fund_case_report_child_idx").on(table.child_session_id),
    uniqueIndex("fund_case_report_sha_idx").on(table.report_sha256),
    index("fund_case_report_case_role_idx").on(table.case_id, table.role),
    check("fund_case_report_confidence_range", sql`${table.confidence} BETWEEN 0 AND 1`),
  ],
)

export const FundCaseReportAdmissionTable = sqliteTable(
  "fund_case_report_admission",
  {
    attestation_id: text().primaryKey(),
    case_id: text()
      .notNull()
      .references(() => FundCaseTable.case_id, { onDelete: "restrict" }),
    submission_id: text()
      .notNull()
      .references(() => FundCaseReportSubmissionTable.submission_id, { onDelete: "restrict" }),
    child_session_id: text()
      .notNull()
      .references(() => FundCaseChildTable.child_session_id, { onDelete: "restrict" }),
    role: text().notNull(),
    report_sha256: text().notNull(),
    admitted_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex("fund_case_report_admission_submission_idx").on(table.submission_id),
    uniqueIndex("fund_case_report_admission_child_idx").on(table.child_session_id),
    uniqueIndex("fund_case_report_admission_sha_idx").on(table.report_sha256),
    index("fund_case_report_admission_case_role_idx").on(table.case_id, table.role),
  ],
)

export const FundCaseDraftTable = sqliteTable(
  "fund_case_draft",
  {
    draft_id: text().primaryKey(),
    case_id: text()
      .notNull()
      .references(() => FundCaseTable.case_id, { onDelete: "restrict" }),
    event_id: text().notNull(),
    action: text().notNull(),
    payload_json: text().notNull(),
    draft_sha256: text().notNull(),
    risk_tier: text().notNull(),
    human_approval_required: integer({ mode: "boolean" }).notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("fund_case_draft_case_idx").on(table.case_id),
    uniqueIndex("fund_case_draft_event_idx").on(table.event_id),
    uniqueIndex("fund_case_draft_sha_idx").on(table.draft_sha256),
  ],
)

export const FundCaseProposalTable = sqliteTable(
  "fund_case_proposal",
  {
    proposal_id: text().primaryKey(),
    case_id: text()
      .notNull()
      .references(() => FundCaseTable.case_id, { onDelete: "restrict" }),
    event_id: text().notNull(),
    action: text().notNull(),
    payload_json: text().notNull(),
    proposal_sha256: text().notNull(),
    idempotency_key: text().notNull(),
    risk_tier: text().notNull(),
    human_approval_required: integer({ mode: "boolean" }).notNull(),
    gateway_review: text().notNull(),
    execution_authorized: integer({ mode: "boolean" }).notNull().default(false),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("fund_case_proposal_case_idx").on(table.case_id),
    uniqueIndex("fund_case_proposal_event_idx").on(table.event_id),
    uniqueIndex("fund_case_proposal_sha_idx").on(table.proposal_sha256),
    uniqueIndex("fund_case_proposal_idempotency_idx").on(table.idempotency_key),
    check("fund_case_proposal_never_executable", sql`${table.execution_authorized} = 0`),
  ],
)
