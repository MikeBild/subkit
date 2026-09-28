import type { components } from "@/api/schema";
import type { ApiAccessSection } from "@/app/links";
import type { QueryView } from "@/components/failure-state";
import type { TranslationKey } from "@/lib/i18n";
import type { CatalogLabel } from "@/lib/machine-label";
import { permissionLabel } from "@/pages/admin-model";

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

// ── Page order ──────────────────────────────────────────────────────────────

/**
 * The sections in the order a reader acts on them: Kontoverbindungen — the section the
 * OAuth callback and the old `/connections` address land on, and the only one
 * whose rows lapse on their own and ask for a renewal; then the keys this
 * installation hands out; then the applications connected to it, which a
 * person mostly reads and seldom acts on. Kontoverbindungen used to come last,
 * below a wall of dead application registrations, where nobody reached it.
 */
export const API_ACCESS_ORDER = [
  "grants",
  "keys",
  "clients",
] as const satisfies readonly ApiAccessSection[];

/** The sections this reader may read, in page order. */
export function readableSections(can: Record<ApiAccessSection, boolean>): ApiAccessSection[] {
  return API_ACCESS_ORDER.filter((section) => can[section]);
}

/**
 * Whether a deep link may scroll to its section yet. Every list above and
 * around the target grows when it arrives; scrolling while one is still a
 * skeleton lands on a heading that the next render pushes out of view. So:
 * only once no readable list is still loading — an error is settled too.
 */
export function deepLinkReady(views: readonly QueryView[]): boolean {
  return views.every((view) => view !== "loading");
}

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

/**
 * Keys in two groups: the ones that still hold rights (an expired key is
 * among them — it needs a decision, and its row says so), and
 * the revoked ones, which hold nothing and are collapsed behind their count.
 */
export function groupApiKeys<T extends Pick<ApiKeyItem, "revoked_at">>(
  keys: readonly T[],
): { active: T[]; revoked: T[] } {
  return {
    active: keys.filter((key) => !key.revoked_at),
    revoked: keys.filter((key) => Boolean(key.revoked_at)),
  };
}

// ── Connected applications ──────────────────────────────────────────────────

export interface ClientGroups<T> {
  /** Someone's valid grant keeps these working — what a reader came for. */
  granted: T[];
  /** Registered and enabled, but nobody holds a grant: nothing can use them. */
  ungranted: T[];
  /** Retired by housekeeping or revoked by an administrator: not listed by default. */
  disabled: T[];
}

/**
 * Applications in the order a reader needs them. Production held ~500
 * registrations against four real applications; listed flat, the real ones
 * drowned and the section below them was out of reach.
 */
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

// ── Key state ───────────────────────────────────────────────────────────────

/** A key that lapses within this many days says so on its row. */
export const KEY_EXPIRING_DAYS = 7;

/**
 * The one state word a key's row carries, or none.
 *
 * Zugangsdaten used to raise these as a second task list above its sections;
 * the tasks live on Heute, and a key's state belongs on the key. One word per
 * row, the most pressing first: a revoked key holds nothing, an expired one no
 * longer works, one about to lapse will stop soon, and one nobody has used
 * for months is a standing right nobody needs (§11). A fresh key nobody has
 * used yet carries nothing — its use line already says "Nie benutzt".
 */
export type KeyState =
  | { kind: "revoked" }
  | { kind: "expired" }
  | { kind: "expiring"; days: number }
  | { kind: "neverUsed"; days: number }
  | { kind: "idle"; days: number };

export function keyState(
  key: Pick<ApiKeyItem, "revoked_at" | "expires_at" | "last_used_at" | "created_at">,
  nowMs: number,
): KeyState | null {
  if (key.revoked_at) return { kind: "revoked" };
  if (keyExpired(key, nowMs)) return { kind: "expired" };
  if (key.expires_at !== null) {
    const left = Date.parse(key.expires_at) - nowMs;
    if (left <= KEY_EXPIRING_DAYS * 86_400_000)
      return { kind: "expiring", days: Math.floor(left / 86_400_000) };
  }
  const idle = keyIdleDays(key, nowMs);
  if (idle === null) return null;
  return key.last_used_at ? { kind: "idle", days: idle } : { kind: "neverUsed", days: idle };
}

/** The chip's words: "läuft ab in 3 Tagen", "abgelaufen", "seit 120 Tagen ungenutzt". */
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
