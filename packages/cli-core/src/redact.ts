/**
 * Shallow deny-list of field names that must never appear in log output.
 * Matching is case-insensitive; keys are compared lowercased.
 */
const SENSITIVE_KEYS = new Set<string>([
  "password",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "cookie",
  "set-cookie",
  "master_key",
  "bot_token",
  "client_secret",
  "signing_secret",
  "service_account_json",
  "private_key",
  // P12: Slack signing
  "slack_signing_secret",
  "slack_bot_token",
  // P12: Teams app password
  "teams_app_password",
  "teams_client_secret",
  // P12: Google service-account JSON blob
  "google_service_account",
  "google_service_account_json",
  "google_credentials_json",
  // P14: tunnel join secret
  "tunnel_api_key",
  "tunnel_token",
  "tunnel_secret",
  // refresh tokens (oauth2)
  "refresh_token",
  "access_token",
  "id_token",
  // connection strings
  "database_url",
  "connection_string",
  "connectionstring",
]);

const REDACTED = "***redacted***";
const MAX_DEPTH = 4;

/** Regex scrubs applied to any string value (top-level or nested). */
const SCRUBBERS: RegExp[] = [
  // Bearer tokens in headers or free-form strings
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  // Slack-style signature headers e.g. `v0=abcdef...`
  /v0=[a-f0-9]{16,}/gi,
  // Subkit API keys `wf_live_...` / `wf_test_...`
  /wf_(live|test)_[a-zA-Z0-9]+/g,
  // Postgres connection strings with credentials
  /postgres(?:ql)?:\/\/[^:]+:[^@]+@/gi,
];

function scrubString(value: string): string {
  let out = value;
  for (const re of SCRUBBERS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

export function redact(input: unknown, depth = 0): unknown {
  if (input == null) return input;
  if (depth >= MAX_DEPTH) return "[depth-exceeded]";

  if (typeof input === "string") return scrubString(input);
  if (typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => redact(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(value, depth + 1);
    }
  }
  return out;
}
