export type { ScrubOptions, SecretKind, SecretPattern, SecretSpan } from "@shared/redaction.ts";
export {
  findSecretSpans,
  SECRET_PATTERNS,
  SENSITIVE_KEY_PATTERN,
  scrubSecrets,
  scrubString,
  scrubStringsDeep,
} from "@shared/redaction.ts";
