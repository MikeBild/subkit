// api_keys row → ResolvedPrincipal.
//
// Shared by the two credentials that are bound to an `api_keys` row: the key
// itself (`providers/api-key.ts`) and the short-lived token an RFC 8693
// exchange mints from it (`auth/oauth/token-exchange.ts`). Both must apply the
// SAME state checks (revoked / not-yet-active / expired / rotated-out) and the
// SAME owner resolution (user or system account, role, e-mail), so that a
// token can never outlive or outrank the key it came from. Keeping the logic
// here means "revoke the key" invalidates its tokens by construction: the
// token provider re-reads the row on every use and runs this function.

import { eq } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { apiKeys, roles as rolesTable, systemAccounts, users } from "../../db/schema/index.ts";
import { log, logger } from "../../logging/logger.ts";
import type { AllowList, ResolvedPrincipal } from "../types.ts";

export type ApiKeyRow = typeof apiKeys.$inferSelect;

const FLUSH_INTERVAL_MS = 60_000;
const lastFlush = new Map<string, number>();

/** Test seam: clear the in-process `last_used_at` throttle. */
export function resetApiKeyUsageThrottle(): void {
  lastFlush.clear();
}

export function normalizeAllowList(value: unknown): AllowList | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === "*") return "all";
    return value as string[];
  }
  return undefined;
}

export function normalizeScopes(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value as string[];
  return undefined;
}

async function maybeFlushLastUsed(
  db: Db,
  keyId: string,
  tenantId: string,
  prefix: string,
): Promise<void> {
  const now = Date.now();
  const last = lastFlush.get(keyId) ?? 0;
  if (now - last < FLUSH_INTERVAL_MS) return;
  lastFlush.set(keyId, now);

  // Best-effort flush — never block the request.
  void db
    .update(apiKeys)
    .set({ last_used_at: new Date(now) })
    .where(eq(apiKeys.id, keyId))
    .catch((err: unknown) => {
      logger.warn({
        module: "auth",
        action: "api_key.last_used_flush_failed",
        msg: "failed to update api_keys.last_used_at",
        api_key_id: keyId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  // Sampled audit row — every 60 s window per key, not per request. We
  // bind the audit row to the same per-request executor the caller
  // handed in so tests using per-DB isolation still observe the write.
  audit(
    {
      tenant_id: tenantId,
      actor_type: "system",
      action: AuditAction.API_KEY_USED,
      resource_type: "api_key",
      resource_id: keyId,
      result: "success",
      metadata: { prefix, sampled: true, window_ms: FLUSH_INTERVAL_MS },
    },
    db,
  );
}

export interface ResolveApiKeyRowOptions {
  /** Auth provider name written to logs and the denial audit metadata. */
  provider: string;
  /** Marks a principal that reached the row through an exchanged token. */
  via?: "token_exchange";
}

function denied(db: Db, row: ApiKeyRow, reason: string, provider: string): null {
  log.auth.denied({ provider, reason, api_key_id: row.id });
  audit(
    {
      tenant_id: row.tenant_id,
      actor_type: "system",
      action: AuditAction.AUTH_LOGIN_FAILED,
      resource_type: "api_key",
      resource_id: row.id,
      result: "denied",
      reason,
      metadata: { provider },
    },
    db,
  );
  return null;
}

/** State of the key row alone — no owner lookup. `null` means live. */
export function apiKeyRowDenialReason(row: ApiKeyRow, now: Date): string | null {
  if (row.revoked_at && row.revoked_at <= now) return "revoked";
  if (row.not_before && row.not_before > now) return "not_yet_active";
  if (row.expires_at && row.expires_at <= now) return "expired";
  // Soft revoke after the rotation overlap window has elapsed.
  if (row.rotating_out_at && row.rotating_out_at <= now) return "rotated_out";
  return null;
}

/**
 * Turn a matched `api_keys` row into a principal, or `null` when the row or
 * its owner must not authenticate. Every refusal is logged and audited.
 */
export async function resolvePrincipalFromApiKeyRow(
  db: Db,
  row: ApiKeyRow,
  opts: ResolveApiKeyRowOptions,
): Promise<ResolvedPrincipal | null> {
  const provider = opts.provider;
  const stateReason = apiKeyRowDenialReason(row, new Date());
  if (stateReason) return denied(db, row, stateReason, provider);

  // Resolve owner -> kind, id, role.
  let kind: "user" | "system_account";
  let ownerId: string;
  let roles: string[];
  let email: string | undefined;

  if (row.user_id) {
    kind = "user";
    ownerId = row.user_id;
    // tenant-filter:exempt — prefix-based credential lookup pre-tenant
    const userRows = await db
      .select({
        email: users.email,
        role_id: users.role_id,
        role_name: rolesTable.name,
        status: users.status,
        deleted_at: users.deleted_at,
      })
      .from(users)
      .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
      .where(eq(users.id, row.user_id))
      .limit(1);
    const u = userRows[0];
    if (!u) {
      log.auth.denied({ provider, reason: "user_missing", api_key_id: row.id });
      return null;
    }
    // Disabling or soft-deleting a user must immediately void their
    // credentials — a still-valid API key for a deactivated account is
    // exactly what an operator expects revocation to prevent.
    if (u.deleted_at !== null || u.status !== "active") {
      log.auth.denied({
        provider,
        reason: u.deleted_at !== null ? "user_deleted" : "user_disabled",
        api_key_id: row.id,
      });
      return null;
    }
    roles = u.role_name ? [u.role_name] : [];
    email = u.email;
  } else if (row.system_account_id) {
    kind = "system_account";
    ownerId = row.system_account_id;
    // tenant-filter:exempt — prefix-based credential lookup pre-tenant
    const acctRows = await db
      .select({
        id: systemAccounts.id,
        role_id: systemAccounts.role_id,
        role_name: rolesTable.name,
        deleted_at: systemAccounts.deleted_at,
      })
      .from(systemAccounts)
      .leftJoin(rolesTable, eq(rolesTable.id, systemAccounts.role_id))
      .where(eq(systemAccounts.id, row.system_account_id))
      .limit(1);
    const acct = acctRows[0];
    if (!acct) {
      log.auth.denied({ provider, reason: "system_account_missing", api_key_id: row.id });
      return null;
    }
    // A soft-deleted system account must not authenticate.
    if (acct.deleted_at !== null) {
      log.auth.denied({ provider, reason: "system_account_deleted", api_key_id: row.id });
      return null;
    }
    // Pass-2 C7: stop hardcoding `admin`. If the row has no
    // role_id, fall back to `member` — the safer default.
    roles = [acct.role_name ?? "member"];
  } else {
    log.auth.denied({ provider, reason: "key_has_no_owner", api_key_id: row.id });
    return null;
  }

  const principal: ResolvedPrincipal = {
    provider: "api_key",
    kind,
    id: ownerId,
    tenant_id: row.tenant_id,
    roles,
    api_key_id: row.id,
  };
  const scopes = normalizeScopes(row.scopes);
  if (scopes !== undefined) principal.scopes = scopes;
  const allowedWorkflows = normalizeAllowList(row.allowed_workflows);
  if (allowedWorkflows !== undefined) principal.allowed_workflows = allowedWorkflows;
  const allowedConnectors = normalizeAllowList(row.allowed_connectors);
  if (allowedConnectors !== undefined) principal.allowed_connectors = allowedConnectors;
  if (email !== undefined) principal.email = email;
  if (opts.via) principal.via = opts.via;

  log.auth.resolved({
    provider,
    principal_kind: kind,
    principal_id: ownerId,
    api_key_id: row.id,
    tenant_id: row.tenant_id,
  });

  await maybeFlushLastUsed(db, row.id, row.tenant_id, row.prefix);

  return principal;
}
