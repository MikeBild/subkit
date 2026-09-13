// Typed audit recorders — barrel export.
//
// Every state-changing path lands its audit row through one
// of these helpers. The recorders are thin wrappers around
// `auditAwait` that lock the metadata shape at compile time so a
// schema drift in one call site cannot silently desynchronise the
// audit trail.

export {
  recordConnectorCreated,
  type RecordConnectorCreatedParams,
  recordConnectorDeleted,
  type RecordConnectorDeletedParams,
  recordConnectorDiscovered,
  type RecordConnectorDiscoveredParams,
  recordConnectorDraftCredentialRejected,
  type RecordConnectorDraftCredentialRejectedParams,
  recordConnectorInvoked,
  type RecordConnectorInvokedParams,
  recordConnectorSavedOverride,
  type RecordConnectorSavedOverrideParams,
  recordConnectorUpdated,
  type RecordConnectorUpdatedParams,
} from "./connector.ts";
export {
  recordConversationSkillLoaded,
  type RecordConversationSkillLoadedParams,
} from "./conversation.ts";
export {
  recordCredentialAttached,
  type RecordCredentialAttachedParams,
  recordCredentialDeleted,
  type RecordCredentialDeletedParams,
  recordCredentialRotated,
  type RecordCredentialRotatedParams,
  recordOAuthClientRegistered,
  type RecordOAuthClientRegisteredParams,
  recordOAuthClientRegistrationFailed,
  type RecordOAuthClientRegistrationFailedParams,
} from "./credential.ts";
export {
  recordEngineUpdateCompleted,
  type RecordEngineUpdateCompletedParams,
  recordEngineUpdateFailed,
  type RecordEngineUpdateFailedParams,
  recordEngineUpdateInitiated,
  type RecordEngineUpdateInitiatedParams,
  recordEngineUpdateRolledBack,
  type RecordEngineUpdateRolledBackParams,
} from "./engine-update.ts";
export {
  recordExecutionCrashRecovered,
  type RecordExecutionCrashRecoveredParams,
} from "./execution.ts";
export {
  recordKnowledgeSourceCandidatesSynthesized,
  type RecordKnowledgeSourceCandidatesSynthesizedParams,
  recordKnowledgeSourceCreated,
  type RecordKnowledgeSourceCreatedParams,
  recordKnowledgeSourceRefreshed,
  type RecordKnowledgeSourceRefreshedParams,
} from "./knowledge.ts";
export {
  type PaletteAssemblyFailureReason,
  recordConnectorMcpAuthorizationFailed,
  type RecordConnectorMcpAuthorizationFailedParams,
  type RecordConnectorMcpAuthorizationParams,
  recordConnectorMcpAuthorizationStarted,
  recordConnectorMcpAuthorized,
  recordConnectorMcpClientRegistered,
  type RecordConnectorMcpClientRegisteredParams,
  recordConnectorMcpHandshakeOk,
  type RecordConnectorMcpHandshakeOkParams,
  recordConnectorMcpManifestDrift,
  type RecordConnectorMcpManifestDriftParams,
  recordMcpExternalToolInvoked,
  type RecordMcpExternalToolInvokedParams,
  recordMcpExternalToolPaletteAssemblyFailed,
  type RecordMcpExternalToolPaletteAssemblyFailedParams,
} from "./mcp-server.ts";
export {
  recordToolPolicyConfirmationRequired,
  type RecordToolPolicyConfirmationRequiredParams,
  recordToolPolicyConfirmCollapsedMcp,
  type RecordToolPolicyConfirmCollapsedMcpParams,
} from "./policy.ts";
export type { AuditOutcome, RecordedEntry, RecorderBase } from "./types.ts";
export {
  recordWorkflowCommitted,
  type RecordWorkflowCommittedParams,
  recordWorkflowCreated,
  type RecordWorkflowCreatedParams,
  recordWorkflowDeleted,
  type RecordWorkflowDeletedParams,
  recordWorkflowScheduleNotBound,
  type RecordWorkflowScheduleNotBoundParams,
  recordWorkflowUpdated,
  type RecordWorkflowUpdatedParams,
} from "./workflow.ts";
