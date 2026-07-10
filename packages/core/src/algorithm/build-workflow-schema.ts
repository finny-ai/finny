// Keep the Drizzle-discovered `*.sql.ts` module as the schema authority while
// giving TypeScript consumers a normal module name. The opencode package's
// ambient `*.sql` declaration otherwise shadows these named exports.
export {
  AlgorithmBuildApprovalChallengeTable,
  AlgorithmBuildWorkflowEventTable,
  AlgorithmBuildWorkflowTable,
} from "./build-workflow.sql"
