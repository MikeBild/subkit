import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

export type ConnectionItem = components["schemas"]["Connection"];
export type ConnectionState = ConnectionItem["state"];
export type ConnectionStateReason = NonNullable<ConnectionItem["state_reason"]>;

export type DiscoveryItem = components["schemas"]["ConnectionDiscoverResponse"];

export function connectionStateKey(state: ConnectionItem["state"]): TranslationKey {
  switch (state) {
    case "valid":
      return "connections.state.valid";
    case "expiring":
      return "connections.state.expiring";
    case "expired":
      return "connections.state.expired";
    case "unreadable":
      return "connections.state.unreadable";
  }
}

export function connectionReasonKey(reason: ConnectionStateReason): TranslationKey {
  switch (reason) {
    case "refresh_refused":
      return "connections.reason.refreshRefused";
    case "refresh_failed":
      return "connections.reason.refreshFailed";
    case "expired_no_refresh":
      return "connections.reason.expiredNoRefresh";
    case "secret_unreadable":
      return "connections.reason.secretUnreadable";
  }
}

export function connectionNeedsRenewal(item: Pick<ConnectionItem, "state">): boolean {
  return item.state === "expired" || item.state === "unreadable";
}

export function connectionFailureKey(code: string | null): TranslationKey {
  switch (code) {
    case "denied":
      return "connections.failure.denied";
    case "state_invalid":
      return "connections.failure.stateInvalid";
    case "token_exchange_failed":
      return "connections.failure.tokenExchange";
    case "discovery_missing":
      return "connections.failure.discoveryMissing";
    case "discovery_failed":
      return "connections.failure.discoveryFailed";
    case "registration_missing":
      return "connections.failure.registrationMissing";
    case "registration_failed":
      return "connections.failure.registrationFailed";
    case "pkce_unsupported":
      return "connections.failure.pkceUnsupported";
    case "base_url_invalid":
      return "connections.failure.baseUrlInvalid";
    case "name_taken":
      return "connections.failure.nameTaken";
    case "name_invalid":
      return "connections.failure.nameInvalid";
    default:
      return "connections.failure.other";
  }
}

export function suggestConnectionName(serviceName: string | null, baseUrl: string): string {
  return slugOf(serviceName ?? "") || slugOf(hostOf(baseUrl)) || "konto";
}

function slugOf(source: string): string {
  return source
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, "").split(".")[0] ?? "";
  } catch {
    return "";
  }
}

export const CALLBACK_PARAMS = ["connected", "renewed", "failed", "name"] as const;

export function withoutCallbackParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of CALLBACK_PARAMS) params.delete(key);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export type CallbackOutcome =
  | { kind: "connected"; name: string; renewed: boolean }
  | { kind: "failed"; code: string; name: string | null }
  | null;

export function readCallbackOutcome(search: string): CallbackOutcome {
  const params = new URLSearchParams(search);
  const connected = params.get("connected");
  if (connected)
    return { kind: "connected", name: connected, renewed: params.get("renewed") === "1" };
  const failed = params.get("failed");
  if (failed) return { kind: "failed", code: failed, name: params.get("name") };
  return null;
}

export function parseTypedScopes(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
