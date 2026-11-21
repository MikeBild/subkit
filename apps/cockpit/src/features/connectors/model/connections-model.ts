import type { components } from "@cli-core/engine-api/openapi";
import type { TranslationKey } from "@/lib/i18n";

export type ConnectionItem = components["schemas"]["Connection"];
export type ConnectionState = ConnectionItem["state"];
export type ConnectionStateReason = NonNullable<ConnectionItem["state_reason"]>;

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
