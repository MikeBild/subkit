import type { components } from "@/api/schema";
import { absolute, apiAccessHref } from "@/app/links";
import type { AttentionListItem } from "@/components/cockpit/attention-list";
import type { TranslationKey } from "@/lib/i18n";
import type { CatalogLabel } from "@/lib/machine-label";
import { permissionLabel } from "@/pages/admin-model";
import {
  type ConnectionItem,
  connectionNeedsRenewal,
  connectionReasonKey,
} from "@/pages/connections-model";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

export type ApiKeyItem = components["schemas"]["ApiKey"];
export type ConnectedClientItem = components["schemas"]["OAuthClient"];

/** The wildcard a key carries when it asserts no narrowing (`auth/scopes.ts`). */
export const WILDCARD_SCOPE = "*";

/**
 * How long the old key keeps working after a rotation. Sent explicitly, so the
 * sentence in the confirmation and the engine's behaviour cannot drift apart.
 */
export const ROTATE_OVERLAP_MINUTES = 60;

/** A key nobody has used for this long is a standing right nobody needs (§11). */
export const UNUSED_KEY_DAYS = 90;

// ── Scopes ──────────────────────────────────────────────────────────────────

/** Three risk words (§11 Fähigkeits-Inventur): reading never hides writing. */
export type ScopeRisk = "reads" | "writes" | "manages";

const READ_ACTIONS = new Set(["read", "list", "export"]);
const MANAGE_ACTIONS = new Set(["admin", "approve", "promote", "revoke", "rotate", "delete"]);
/** Resources whose every change hands out or takes away rights. */
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

/**
 * The risk of one scope. An action this build does not know counts as
 * writing: a label that understates what a key may do is worse than none.
 */
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

/** `workflow:run` as "Workflows · Ausführen"; the wildcard as "all rights of your role". */
export function scopeLabel(scope: string, t: Translate): CatalogLabel {
  if (scope === WILDCARD_SCOPE) return { text: t("apiKeys.scope.all"), machine: false };
  return permissionLabel(scope, t);
}

/**
 * The scopes a person may put on a key they issue for themselves: the
 * permissions they hold (a key's scopes are a ceiling below its owner's role,
 * never above it) plus the wildcard. Sorted by what a scope risks, then by
 * name, so reading comes before changing.
 */
export function scopeCatalogue(permissions: readonly string[]): string[] {
  const order: Record<ScopeRisk, number> = { reads: 0, writes: 1, manages: 2 };
  const scopes = [...new Set(permissions)].filter((scope) => scope.includes(":"));
  scopes.sort((a, b) => order[scopeRisk(a)] - order[scopeRisk(b)] || (a < b ? -1 : a > b ? 1 : 0));
  return [WILDCARD_SCOPE, ...scopes];
}

/** The scopes a new key starts with: run and read workflows, where the person may. */
export function defaultKeyScopes(permissions: readonly string[]): string[] {
  return ["workflow:read", "workflow:run"].filter((scope) => permissions.includes(scope));
}

// ── Keys ────────────────────────────────────────────────────────────────────

export function keyExpired(key: Pick<ApiKeyItem, "expires_at">, nowMs: number): boolean {
  return key.expires_at !== null && Date.parse(key.expires_at) <= nowMs;
}

/** Days since the key was last used — or, never used, since it was made. Null while recent. */
export function keyIdleDays(
  key: Pick<ApiKeyItem, "last_used_at" | "created_at">,
  nowMs: number,
): number | null {
  const since = Date.parse(key.last_used_at ?? key.created_at);
  const days = Math.floor((nowMs - since) / 86_400_000);
  return days >= UNUSED_KEY_DAYS ? days : null;
}

// ── Attention ───────────────────────────────────────────────────────────────

/**
 * What on this page needs a person now, and nothing when all is well (§1: the
 * list renders nothing then). A lost grant is critical and names its cause; an
 * expired key is critical; a key idle for months is a warning — rights pile up
 * silently, and the inventory turns that into a decision (§11).
 */
export function apiAccessAttention(
  input: {
    connections: readonly ConnectionItem[];
    keys: readonly ApiKeyItem[];
    nowMs: number;
  },
  t: Translate,
  dateTime: (value: string) => string,
): AttentionListItem[] {
  const items: AttentionListItem[] = [];
  for (const connection of input.connections) {
    if (!connectionNeedsRenewal(connection)) continue;
    const reason = connection.state_reason ? t(connectionReasonKey(connection.state_reason)) : "";
    items.push({
      id: `grant:${connection.id}`,
      tone: "critical",
      text: t(
        connection.state === "unreadable"
          ? "apiAccess.attention.grantUnreadable"
          : "apiAccess.attention.grantExpired",
        { name: connection.service_name ?? connection.name, reason },
      ),
      engineWording: connection.last_error,
      href: absolute(apiAccessHref("grants")),
      actionLabel: t("connections.renew"),
    });
  }
  for (const key of input.keys) {
    if (key.revoked_at) continue;
    const name = key.name || key.prefix;
    if (keyExpired(key, input.nowMs)) {
      items.push({
        id: `key-expired:${key.id}`,
        tone: "critical",
        text: t("apiAccess.attention.keyExpired", {
          name,
          date: dateTime(key.expires_at ?? key.created_at),
        }),
        engineWording: null,
        href: absolute(apiAccessHref("keys")),
        actionLabel: t("apiAccess.attention.toKeys"),
      });
      continue;
    }
    const idle = keyIdleDays(key, input.nowMs);
    if (idle !== null) {
      items.push({
        id: `key-idle:${key.id}`,
        tone: "warning",
        text: key.last_used_at
          ? t("apiAccess.attention.keyUnused", { name, days: String(idle) })
          : t("apiAccess.attention.keyNeverUsed", { name, date: dateTime(key.created_at) }),
        engineWording: null,
        href: absolute(apiAccessHref("keys")),
        actionLabel: t("apiAccess.attention.toKeys"),
      });
    }
  }
  return items;
}
