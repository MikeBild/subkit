import { SECRET_PATTERNS, SENSITIVE_KEY_PATTERN } from "../logging/index.ts";

const CREDENTIAL_KEY_RE =
  /^(token|api[_-]?key|password|credential|secret|.*_token|authorization|access[_-]?token|client[_-]?secret|private[_-]?key)$/i;

const NON_SECRET_KEYS = new Set<string>([
  "token_endpoint",
  "authorization_endpoint",
  "token_url",
  "authorization_url",
  "issuer_url",
  "token_auth_method",
  "token_endpoint_auth_method",
  "token_content_type",
  "env_secret_names",
]);

function containsCredentialShape(value: unknown, path: string, depth: number): string | null {
  if (depth > 12) return null;
  if (value === null || value === undefined) return null;

  if (typeof value === "string") {
    for (const { regex } of SECRET_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(value)) {
        regex.lastIndex = 0;
        return path;
      }
      regex.lastIndex = 0;
    }
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) return null;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!NON_SECRET_KEYS.has(key.toLowerCase())) {
      if (SENSITIVE_KEY_PATTERN.test(key) || CREDENTIAL_KEY_RE.test(key)) {
        return childPath;
      }
    }
    const hit = containsCredentialShape(child, childPath, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

export function findCredentialKeyPath(value: unknown, root = ""): string | null {
  return containsCredentialShape(value, root, 0);
}
