// Shared types between engine, CLI, and tunnel agent. Apps consume these via
// the `@shared/*` tsconfig path mapping. Add types here only when more than
// one app needs the same shape — engine-internal types stay in
// `apps/engine/src/api/` and `apps/engine/src/...`.

export {
  ConnectorOperationError,
  isConnectorOperationError,
} from "./connector-operation-error.ts";
export type { SecretKind, SecretPattern } from "./redaction.ts";
export {
  redactWithMaxDepth,
  SECRET_PATTERNS,
  SENSITIVE_KEY_PATTERN,
  scrubSecrets,
  scrubString,
} from "./redaction.ts";
export type { UxGatingPermission } from "./ux-gating.ts";
export { UX_GATING_PERMISSIONS } from "./ux-gating.ts";
export type {
  RoundtripResult,
  ValidationIssue,
  ValidationResult,
} from "./validation-result.ts";
export { fail, ok } from "./validation-result.ts";
