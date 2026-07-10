import { Schema } from "effect"

export class WorkflowStateCorruptError extends Schema.TaggedErrorClass<WorkflowStateCorruptError>()(
  "AlgorithmBuildWorkflowStateCorrupt",
  {
    workflowId: Schema.String,
  },
) {
  override get message() {
    return `Stored algorithm build workflow ${this.workflowId} is corrupt or uses an unsupported schema.`
  }
}
