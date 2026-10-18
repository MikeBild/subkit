export type { ScrubOptions, SecretKind, SecretPattern, SecretSpan } from "@shared/redaction.ts";
export {
  DEFAULT_REDACTED,
  findSecretSpans,
  isAlreadyRedacted,
  isLogSensitiveKey,
  referencesKeyMaterialPath,
  SECRET_PATTERNS,
  SENSITIVE_KEY_PATTERN,
  scrubSecrets,
  scrubString,
  scrubStringsDeep,
} from "@shared/redaction.ts";
