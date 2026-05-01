// Typed audit recorders — barrel export.
//
// Every Wave 1..3 state-changing path lands its audit row through one
// of these helpers. The recorders are thin wrappers around
// `auditAwait` that lock the metadata shape at compile time so a
// schema drift in one call site cannot silently desynchronise the
// audit trail.

export {
  type RecordConnectorCreatedParams,
  type RecordConnectorDeletedParams,
  type RecordConnectorDiscoveredParams,
  type RecordConnectorDraftCredentialRejectedParams,
  type RecordConnectorInvokedParams,
  type RecordConnectorSavedOverrideParams,
  type RecordConnectorUpdatedParams,
  recordConnectorCreated,
  recordConnectorDeleted,
  recordConnectorDiscovered,
  recordConnectorDraftCredentialRejected,
  recordConnectorInvoked,
  recordConnectorSavedOverride,
  recordConnectorUpdated,
} from "./connector.ts";
export {
  type RecordCredentialAttachedParams,
  type RecordCredentialDeletedParams,
  type RecordCredentialRotatedParams,
  recordCredentialAttached,
  recordCredentialDeleted,
  recordCredentialRotated,
} from "./credential.ts";
export {
  type RecordExecutionCrashRecoveredParams,
  recordExecutionCrashRecovered,
} from "./execution.ts";
export {
  type RecordKnowledgeSourceCandidatesSynthesizedParams,
  type RecordKnowledgeSourceCreatedParams,
  type RecordKnowledgeSourceRefreshedParams,
  recordKnowledgeSourceCandidatesSynthesized,
  recordKnowledgeSourceCreated,
  recordKnowledgeSourceRefreshed,
} from "./knowledge.ts";
export {
  type RecordToolPolicyConfirmationRequiredParams,
  recordToolPolicyConfirmationRequired,
} from "./policy.ts";
export type { AuditOutcome, RecordedEntry, RecorderBase } from "./types.ts";
export {
  type RecordWorkflowCommittedParams,
  type RecordWorkflowCreatedParams,
  type RecordWorkflowDeletedParams,
  type RecordWorkflowUpdatedParams,
  recordWorkflowCommitted,
  recordWorkflowCreated,
  recordWorkflowDeleted,
  recordWorkflowUpdated,
} from "./workflow.ts";
