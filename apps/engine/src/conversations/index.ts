// Conversations: persistent resumable AI authoring sessions streamed
// over SSE (REST) and MCP progress notifications. Structured-intent
// tool loop landed in P10.

// `mergeAbortSignals` is deliberately NOT re-exported. Sole consumer
// is `./loop.ts`, which imports it directly from `./abort.ts`. Widening
// the public surface invites cross-package use that hides ownership of
// the merged controller's lifetime. Keeping this rationale inline so
// an "organize imports" tool doesn't strand it.
export {
  cancelConversationAbort,
  CONVERSATION_CANCELLED_REASON,
  registerConversationAbort,
  unregisterConversationAbort,
} from "./abort.ts";
export * from "./answer-actor.ts";
export {
  type ApprovalResumeEnqueuer,
  completeApprovalBackedElicitation,
} from "./approval-completion.ts";
export * from "./attachments.ts";
// Re-exported so http/routes/conversations/stream.ts can re-derive the
// terminal citations frame on replay through the subsystem entry point
// (route_layering invariant) rather than reaching into ./citations.ts.
export { type Citation, harvestCitations, harvestCitationsFromPersisted } from "./citations.ts";
export {
  DirectInvokeError,
  type DirectInvokeOutcome,
  type DirectInvokeParams,
  invokeConversationToolDirect,
} from "./direct-invoke.ts";
export {
  DRAFT_CREDENTIAL_SETUP_KIND,
  isDraftCredentialSetupAuthType,
  mintDraftCredentialSetupUrl,
  validateDraftCredentialSetup,
} from "./draft-credential-setup.ts";
export * from "./lifecycle-view.ts";
export {
  claimDraftCredentialNativeUrlElicitation,
  completeDraftCredentialNativeUrlElicitation,
  markApprovalElicitationsComplete,
  markConnectorNativeUrlElicitationsComplete,
  releaseDraftCredentialNativeUrlElicitation,
} from "./native-url-elicitation.ts";
export * from "./parts.ts";
export { clearDraftCredential, setDraftCredential } from "./persistence/draft-credential-cache.ts";
export * from "./service.ts";
// Re-exported so the replay path can drop since-unresolvable citations before
// the footer, mirroring the live loop's governance filter.
export { keepResolvableCitations } from "./source-faithful.ts";
export * from "./streaming.ts";
export * from "./tool-policies.ts";
// Re-exported so http/routes/conversations/* reach it through the subsystem
// entry point (route_layering invariant) rather than the deep tools path.
export { withoutApprovalHandle } from "./tools/ask-user/commit-intent.ts";
// Same reason, for POST /v1/connectors/import. Worth noting where it sits: this
// function turns a specification into a connector draft and depends on
// connectors/ and llm/flows/document-parsers/ almost exclusively — it lives
// under tools/ because that is where its ConversationTool wrapper is, not
// because it is a conversation concern. Moving the core to connectors/ would be
// the tidier home; until then the barrel is what keeps the route honest.
export {
  importConnectorDraftFromSpec,
  importConnectorFromSpecInputSchema,
} from "./tools/import-connector-from-spec.ts";
export * from "./types.ts";
