import type { components } from "@cli-core/engine-api/openapi";
import { type ActorDirectory, actorDirectoryName } from "@/app/actor-directory-model";
import type { ApiAccessSection } from "@/app/links";
import type { TranslationKey } from "@/lib/i18n";
import type { CatalogLabel } from "@/lib/machine-label";
import { permissionLabel } from "@/pages/admin-model";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type ApiKeyItem = components["schemas"]["ApiKey"];

export function apiKeyOwnerLabel(
  owner: Pick<ApiKeyItem, "user_id" | "system_account_id">,
  directory: ActorDirectory,
  t: Translate,
): string {
  if (owner.user_id && !owner.system_account_id) {
    return actorDirectoryName(directory, "user", owner.user_id) ?? t("audit.actor.user");
  }
  if (owner.system_account_id && !owner.user_id) {
    return (
      actorDirectoryName(directory, "system_account", owner.system_account_id) ??
      t("audit.actor.systemAccount")
    );
  }
  return t("common.unknown");
}

export function apiKeyCreatorLabel(
  creator: ApiKeyItem["creator"],
  directory: ActorDirectory,
  t: Translate,
): string {
  if (!creator) return t("common.unknown");
  if (creator.kind === "system") return t("audit.actor.system");
  return (
    actorDirectoryName(directory, creator.kind, creator.id) ??
    t(creator.kind === "user" ? "audit.actor.user" : "audit.actor.systemAccount")
  );
}
export type ConnectedClientItem = components["schemas"]["OAuthClient"];

interface ConnectedClientHistoryLine {
  person: string;
  connectedAt: string | null;
  revokedAt: string | null;
  legacyUnknown: boolean;
}

interface ConnectedClientActiveSummary {
  people: string[];
  moreCount: number;
  hasUnknownLegacy: boolean;
}

export function connectedClientActiveSummary(
  connectedBy: ConnectedClientItem["connected_by"],
  t: Translate,
): ConnectedClientActiveSummary {
  const seenUsers = new Set<string>();
  const active = connectedBy.grants
    .filter((grant) => grant.revoked_at === null)
    .sort((left, right) => Date.parse(right.connected_at) - Date.parse(left.connected_at))
    .filter((grant) => {
      if (seenUsers.has(grant.user_id)) return false;
      seenUsers.add(grant.user_id);
      return true;
    });
  return {
    people: active
      .slice(0, 2)
      .map(
        (grant) =>
          grant.display_name?.trim() || grant.email?.trim() || t("connectedClients.unknownPerson"),
      ),
    moreCount: Math.max(0, active.length - 2),
    hasUnknownLegacy: connectedBy.has_unknown_legacy,
  };
}

export function connectedClientHistory(
  connectedBy: ConnectedClientItem["connected_by"],
  t: Translate,
): ConnectedClientHistoryLine[] {
  const grants: ConnectedClientHistoryLine[] = connectedBy.grants
    .map((grant) => ({
      person:
        grant.display_name?.trim() || grant.email?.trim() || t("connectedClients.unknownPerson"),
      connectedAt: grant.connected_at,
      revokedAt: grant.revoked_at,
      legacyUnknown: false,
    }))
    .sort(
      (left, right) => Date.parse(right.connectedAt ?? "") - Date.parse(left.connectedAt ?? ""),
    );
  if (connectedBy.has_unknown_legacy) {
    grants.push({
      person: t("connectedClients.unknownLegacy"),
      connectedAt: null,
      revokedAt: null,
      legacyUnknown: true,
    });
  }
  return grants;
}

export const API_KEYS_QUERY = ["admin", "api-keys"] as const;

export const WILDCARD_SCOPE = "*";

export const ROTATE_OVERLAP_MINUTES = 1440;

export const UNUSED_KEY_DAYS = 90;

export const API_ACCESS_ORDER = ["keys", "clients"] as const satisfies readonly ApiAccessSection[];

export function readableSections(can: Record<ApiAccessSection, boolean>): ApiAccessSection[] {
  return API_ACCESS_ORDER.filter((section) => can[section]);
}

export function openApiAccessSection(
  requested: ApiAccessSection | null,
  readable: readonly ApiAccessSection[],
): ApiAccessSection | null {
  if (requested && readable.includes(requested)) return requested;
  return readable[0] ?? null;
}

export function keysNeedingAction(
  keys: readonly Pick<ApiKeyItem, "revoked_at" | "expires_at" | "last_used_at" | "created_at">[],
  nowMs: number,
): number {
  return keys.filter((key) => {
    const kind = keyState(key, nowMs)?.kind;
    return kind === "expired" || kind === "expiring";
  }).length;
}

type ScopeRisk = "reads" | "writes" | "manages";

const READ_ACTIONS = new Set(["read", "list", "export"]);
const MANAGE_ACTIONS = new Set(["admin", "approve", "promote", "revoke", "rotate", "delete"]);
const RIGHTS_RESOURCES = new Set([
  "rbac",
  "identity",
  "api_key",
  "settings",
  "credential",
  "connection",
  "mcp_oauth_client",
  "portal_token",
]);

export function scopeRisk(scope: string): ScopeRisk {
  if (scope === WILDCARD_SCOPE) return "manages";
  const [resource = "", action = ""] = scope.split(":");
  if (READ_ACTIONS.has(action)) return "reads";
  if (MANAGE_ACTIONS.has(action) || RIGHTS_RESOURCES.has(resource)) return "manages";
  return "writes";
}

const RISK_KEYS: Record<ScopeRisk, TranslationKey> = {
  reads: "apiKeys.risk.reads",
  writes: "apiKeys.risk.writes",
  manages: "apiKeys.risk.manages",
};

export function scopeRiskKey(risk: ScopeRisk): TranslationKey {
  return RISK_KEYS[risk];
}

export function scopeLabel(scope: string, t: Translate): CatalogLabel {
  if (scope === WILDCARD_SCOPE) return { text: t("apiKeys.scope.all"), machine: false };
  return permissionLabel(scope, t);
}

export function scopeCatalogue(permissions: readonly string[]): string[] {
  const order: Record<ScopeRisk, number> = { reads: 0, writes: 1, manages: 2 };
  const scopes = [...new Set(permissions)].filter((scope) => scope.includes(":"));
  scopes.sort((a, b) => order[scopeRisk(a)] - order[scopeRisk(b)] || (a < b ? -1 : a > b ? 1 : 0));
  return [WILDCARD_SCOPE, ...scopes];
}

export function defaultKeyScopes(permissions: readonly string[]): string[] {
  return ["workflow:read", "workflow:run", "intake:read", "intake:write"].filter((scope) =>
    permissions.includes(scope),
  );
}

function keyExpired(key: Pick<ApiKeyItem, "expires_at">, nowMs: number): boolean {
  return key.expires_at !== null && Date.parse(key.expires_at) <= nowMs;
}

export function keyIdleDays(
  key: Pick<ApiKeyItem, "last_used_at" | "created_at">,
  nowMs: number,
): number | null {
  const since = Date.parse(key.last_used_at ?? key.created_at);
  const days = Math.floor((nowMs - since) / 86_400_000);
  return days >= UNUSED_KEY_DAYS ? days : null;
}

export function groupApiKeys<T extends Pick<ApiKeyItem, "revoked_at">>(
  keys: readonly T[],
): { active: T[]; revoked: T[] } {
  return {
    active: keys.filter((key) => !key.revoked_at),
    revoked: keys.filter((key) => Boolean(key.revoked_at)),
  };
}

interface ClientGroups<T> {
  granted: T[];
  ungranted: T[];
  disabled: T[];
}

export function groupConnectedClients<
  T extends Pick<ConnectedClientItem, "disabled_at" | "live_connections" | "created_at">,
>(clients: readonly T[]): ClientGroups<T> {
  const newestFirst = (a: T, b: T) => Date.parse(b.created_at) - Date.parse(a.created_at);
  const enabled = clients.filter((client) => !client.disabled_at);
  return {
    granted: enabled.filter((client) => client.live_connections > 0).sort(newestFirst),
    ungranted: enabled.filter((client) => client.live_connections === 0).sort(newestFirst),
    disabled: clients.filter((client) => Boolean(client.disabled_at)).sort(newestFirst),
  };
}

export const KEY_EXPIRING_DAYS = 7;

type KeyState =
  | { kind: "revoked" }
  | { kind: "expired" }
  | { kind: "expiring"; days: number }
  | { kind: "neverUsed"; days: number }
  | { kind: "idle"; days: number };

export function calendarDaysUntil(targetMs: number, nowMs: number): number {
  const day = (ms: number) => {
    const date = new Date(ms);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  };
  return Math.round((day(targetMs) - day(nowMs)) / 86_400_000);
}

export function keyState(
  key: Pick<ApiKeyItem, "revoked_at" | "expires_at" | "last_used_at" | "created_at">,
  nowMs: number,
): KeyState | null {
  if (key.revoked_at) return { kind: "revoked" };
  if (keyExpired(key, nowMs)) return { kind: "expired" };
  if (key.expires_at !== null) {
    const days = calendarDaysUntil(Date.parse(key.expires_at), nowMs);
    if (days <= KEY_EXPIRING_DAYS) return { kind: "expiring", days };
  }
  const idle = keyIdleDays(key, nowMs);
  if (idle === null) return null;
  return key.last_used_at ? { kind: "idle", days: idle } : { kind: "neverUsed", days: idle };
}

export function keyStateSaysUse(state: KeyState | null): boolean {
  return state?.kind === "idle" || state?.kind === "neverUsed";
}

export function keyStateText(state: KeyState, t: Translate): string {
  switch (state.kind) {
    case "revoked":
      return t("apiKeys.revokedBadge");
    case "expired":
      return t("apiKeys.expiredBadge");
    case "expiring":
      return state.days === 0
        ? t("apiKeys.state.expiresToday")
        : state.days === 1
          ? t("apiKeys.state.expiresTomorrow")
          : t("apiKeys.state.expiresIn", { days: String(state.days) });
    case "neverUsed":
      return t("apiKeys.state.neverUsed", { days: String(state.days) });
    case "idle":
      return t("apiKeys.state.idle", { days: String(state.days) });
  }
}

export type KeyScopePreset = "read" | "run" | "manage" | "clipper";

export function keyPresetScopes(preset: KeyScopePreset, permissions: readonly string[]): string[] {
  return [...new Set(permissions)].filter(
    (scope) =>
      scope.includes(":") &&
      (preset === "clipper"
        ? scope === "intake:read" || scope === "intake:write"
        : preset === "manage" ||
          scopeRisk(scope) === "reads" ||
          (preset === "run" && (scope === "workflow:run" || scope === "intake:write"))),
  );
}
