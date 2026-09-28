import type { components } from "@/api/schema";
import type { TranslationKey } from "@/lib/i18n";

/**
 * What the engine says about one Kontoverbindung (outbound connection) —
 * the generated contract, so a renamed field breaks the build, not the page.
 */
export type ConnectionItem = components["schemas"]["Connection"];
export type ConnectionState = ConnectionItem["state"];
export type ConnectionStateReason = NonNullable<ConnectionItem["state_reason"]>;

export type DiscoveryItem = components["schemas"]["ConnectionDiscoverResponse"];

/** The state word, one per §2/§11 vocabulary; the date rides beside "läuft ab". */
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

/**
 * Why a grant is unusable, as a sentence that ends in the way back (§1: no red
 * without a way to the cause). The engine records a reason for every state
 * that is not ok, so there is never a dash beside "abgelaufen".
 */
export function connectionReasonKey(reason: ConnectionStateReason): TranslationKey {
  switch (reason) {
    case "refresh_failed":
      return "connections.reason.refreshFailed";
    case "expired_no_refresh":
      return "connections.reason.expiredNoRefresh";
    case "secret_unreadable":
      return "connections.reason.secretUnreadable";
  }
}

/** Only a lost grant needs a way back; the others need no red (§1). */
export function connectionNeedsRenewal(item: Pick<ConnectionItem, "state">): boolean {
  return item.state === "expired" || item.state === "unreadable";
}

/** The one sentence the page shows when discovery, the other side, or the exchange said no. */
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

/**
 * A name the person can accept as-is: the service's own name when it has
 * one, otherwise the host, both reduced to what a secret name allows.
 */
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

/** The callback's own words in the address; the page drops these and keeps the rest. */
export const CALLBACK_PARAMS = ["connected", "renewed", "failed", "name"] as const;

/**
 * The address without the callback's words, so a reload does not repeat the
 * sentence — and without losing `section=grants`, which the page is open at.
 */
export function withoutCallbackParams(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of CALLBACK_PARAMS) params.delete(key);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** What the other side sent us back with, read off the page's own query string. */
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

/** Scopes the person can pick: what the server lists, and what a person typed when it lists none. */
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
