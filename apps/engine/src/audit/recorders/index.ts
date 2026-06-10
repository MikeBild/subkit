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
  type RecordOAuthClientRegisteredParams,
  type RecordOAuthClientRegistrationFailedParams,
  recordCredentialAttached,
  recordCredentialDeleted,
  recordCredentialRotated,
  recordOAuthClientRegistered,
  recordOAuthClientRegistrationFailed,
} from "./credential.ts";
export {
  type RecordEngineUpdateCompletedParams,
  type RecordEngineUpdateFailedParams,
  type RecordEngineUpdateInitiatedParams,
  type RecordEngineUpdateRolledBackParams,
  recordEngineUpdateCompleted,
  recordEngineUpdateFailed,
  recordEngineUpdateInitiated,
  recordEngineUpdateRolledBack,
} from "./engine-update.ts";
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
  type RecordMcpExternalToolInvokedParams,
  type RecordMcpExternalToolPaletteAssemblyFailedParams,
  type RecordMcpServerAuthorizationFailedParams,
  type RecordMcpServerAuthorizationStartedParams,
  type RecordMcpServerAuthorizedParams,
  type RecordMcpServerConfigUpdatedParams,
  type RecordMcpServerDeletedParams,
  type RecordMcpServerDisabledParams,
  type RecordMcpServerErroredParams,
  type RecordMcpServerHandshakeOkParams,
  type RecordMcpServerReEnabledParams,
  type RecordMcpServerRegisteredParams,
  recordMcpExternalToolInvoked,
  recordMcpExternalToolPaletteAssemblyFailed,
  recordMcpServerAuthorizationFailed,
  recordMcpServerAuthorizationStarted,
  recordMcpServerAuthorized,
  recordMcpServerConfigUpdated,
  recordMcpServerDeleted,
  recordMcpServerDisabled,
  recordMcpServerErrored,
  recordMcpServerHandshakeOk,
  recordMcpServerReEnabled,
  recordMcpServerRegistered,
} from "./mcp-server.ts";
export {
  type RecordToolPolicyConfirmationRequiredParams,
  recordToolPolicyConfirmationRequired,
} from "./policy.ts";
export type { AuditOutcome, RecordedEntry, RecorderBase } from "./types.ts";
export {
  type RecordWorkflowCommittedParams,
  type RecordWorkflowCreatedParams,
  type RecordWorkflowDeletedParams,
  type RecordWorkflowScheduleNotBoundParams,
  type RecordWorkflowUpdatedParams,
  recordWorkflowCommitted,
  recordWorkflowCreated,
  recordWorkflowDeleted,
  recordWorkflowScheduleNotBound,
  recordWorkflowUpdated,
} from "./workflow.ts";
