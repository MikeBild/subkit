import { isSensitivePayload } from "../execution/sensitive-payload.ts";
import {
  isLogSensitiveKey,
  redactSecretShapes,
  SENSITIVE_KEY_PATTERN,
  scrubString,
} from "../logging/scrub-secrets.ts";

const PRIVATE_KEY =
  /^(?:auth_source|session_id|sessionId|cookie|set-cookie|private_key|access_key_id)$/i;

function privateKey(key: string): boolean {
  return isLogSensitiveKey(key) || SENSITIVE_KEY_PATTERN.test(key) || PRIVATE_KEY.test(key);
}

export function diagnosticProjection(
  input: unknown,
  knownSecrets: readonly string[] = [],
): unknown {
  const seen = new WeakSet<object>();
  const secrets = [...new Set(knownSecrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const project = (value: unknown, depth: number): unknown => {
    if (isSensitivePayload(value)) return "[protected-execution-data]";
    if (typeof value === "string") {
      let safe = value;
      for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
      safe = safe.replace(/https?:\/\/[^\s"<>]+/g, (candidate) => {
        try {
          const url = new URL(candidate);
          if (url.username || url.password) {
            url.username = "redacted";
            url.password = "redacted";
          }
          for (const key of [...url.searchParams.keys()])
            if (privateKey(key)) url.searchParams.set(key, "redacted");
          if (url.hash) url.hash = "redacted";
          return url.toString();
        } catch {
          return "[unavailable-url]";
        }
      });
      return redactSecretShapes(scrubString(safe)).text;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== "object") return null;
    if (depth >= 32) return "[depth-exceeded]";
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((entry) => project(entry, depth + 1));
      const record = value as Record<string, unknown>;
      const fieldName =
        typeof record.name === "string"
          ? record.name
          : typeof record.key === "string"
            ? record.key
            : null;
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          (privateKey(key) &&
            !(
              typeof entry === "number" &&
              ["tokens_in", "tokens_out", "max_tokens", "total_tokens"].includes(
                key.split(".").at(-1) ?? "",
              )
            )) ||
          (key === "value" && fieldName !== null && privateKey(fieldName))
            ? "[redacted]"
            : project(entry, depth + 1),
        ]),
      );
    } finally {
      seen.delete(value);
    }
  };
  return project(input, 0);
}
