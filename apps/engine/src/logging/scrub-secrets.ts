export type { ScrubOptions, SecretKind, SecretPattern, SecretSpan } from "@shared/redaction.ts";
export {
  findSecretSpans,
  scrubSecrets,
  scrubString,
  scrubStringsDeep,
  SECRET_PATTERNS,
  SENSITIVE_KEY_PATTERN,
} from "@shared/redaction.ts";
