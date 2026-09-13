// Shared types between engine and CLI. Apps consume these via the
// `@shared/*` tsconfig path mapping. Add types here only when more than
// one app needs the same shape — engine-internal types stay in
// `apps/engine/src/api/` and `apps/engine/src/...`.

export {
  AUDIT_SOURCE_HEADER,
  AUDIT_SOURCE_VALUES,
  type AuditSource,
  DEPLOY_VERSION_HEADER,
} from "./audit-source.ts";
export { ConnectorOperationError, isConnectorOperationError } from "./connector-operation-error.ts";
export {
  OAUTH_AUTHORIZATION_URL_FIELD,
  OAuthApprovalInputSchema,
} from "./elicitation-constants.ts";
export {
  FILE_LINK_RESOURCE_TYPES,
  type FileLinkResourceType,
  MAX_INLINE_BYTES,
} from "./files-constants.ts";
export { type JsonlTrimOptions, trimJsonlFile } from "./jsonl-ring.ts";
export type { LlmsPage, RenderLlmsIndexOptions } from "./llms-index.ts";
export { OPTIONAL_PATHS, renderLlmsIndex } from "./llms-index.ts";
export type { SecretKind, SecretPattern } from "./redaction.ts";
export {
  redactWithMaxDepth,
  scrubSecrets,
  scrubString,
  SECRET_PATTERNS,
  SENSITIVE_KEY_PATTERN,
} from "./redaction.ts";
export type {
  GraphqlOperation,
  McpOperation,
  McpToolAnnotationHints,
  SideEffect,
  SideEffectInput,
} from "./side-effects.ts";
export {
  classifyHttpSideEffect,
  classifyMcpToolSideEffect,
  httpMethodIsRead,
  inferGraphqlOperation,
  sqlIsSelect,
} from "./side-effects.ts";
export type { UxGatingPermission } from "./ux-gating.ts";
export { UX_GATING_PERMISSIONS } from "./ux-gating.ts";
export type { ValidationIssue, ValidationResult } from "./validation-result.ts";
export { fail, ok } from "./validation-result.ts";
