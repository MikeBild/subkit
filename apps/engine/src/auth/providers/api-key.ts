// api_key auth provider — real implementation.
//
// - Parses `Authorization: Bearer wf_live_<rand>` or `?token=<key>` query
// - Looks up `api_keys` row by prefix
// - Constant-time sha256 comparison
// - Validates not_before / expires_at / revoked_at
// - Schedules a `last_used_at` flush throttled to once per 60s per key
// - Writes `api_key.used` audit row only when the throttle window fires
// - Builds a ResolvedPrincipal populated with tenant + roles + scopes

import { eq, sql } from "drizzle-orm";
import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { type Db, getDb } from "../../db/client.ts";
import { apiKeys, roles as rolesTable, systemAccounts, users } from "../../db/schema/index.ts";
import { constantTimeHexEquals, parseKey } from "../../identity/api-key.ts";
import { log, logger } from "../../logging/logger.ts";
import { recordAuthFailure } from "../failed-auth-tracker.ts";
import type { AllowList, AuthProvider, ResolvedPrincipal } from "../types.ts";

const FLUSH_INTERVAL_MS = 60_000;
const lastFlush = new Map<string, number>();

function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.length > 7 && auth.slice(0, 7).toLowerCase() === "bearer ") {
    return auth.slice(7).trim();
  }
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get("token");
    if (q) return q;
  } catch {
    // ignore — non-absolute URL
  }
  return null;
}

function normalizeAllowList(value: unknown): AllowList | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] === "*") return "all";
    return value as string[];
  }
  return undefined;
}

function normalizeScopes(value: unknown): string[] | undefined {
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

export interface ApiKeyProviderOptions {
  db?: Db;
  // Test seam: clear the in-process throttle map so tests can force a flush.
  resetThrottle?: boolean;
}

export function createApiKeyProvider(opts: ApiKeyProviderOptions = {}): AuthProvider {
  if (opts.resetThrottle) lastFlush.clear();
  return {
    name: "api_key",
    capabilities: {
      human: true,
      machine: true,
      interactive: false,
      refresh: false,
      revoke: true,
    },
    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      const token = extractToken(req);
      if (!token) return null;

      const parsed = parseKey(token);
      if (!parsed) {
        log.auth.denied({ provider: "api_key", reason: "malformed_token" });
        return null;
      }

      const db = opts.db ?? getDb();
      // tenant-filter:exempt — prefix-based credential lookup pre-tenant
      const rows = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.prefix, parsed.prefix))
        .limit(1);
      const row = rows[0];

      if (!row) {
        log.auth.denied({
          provider: "api_key",
          reason: "prefix_not_found",
          prefix: parsed.prefix,
        });
        return null;
      }

      if (!constantTimeHexEquals(row.token_sha256, parsed.hash)) {
        const ip =
          req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          req.headers.get("x-real-ip") ??
          "unknown";
        recordAuthFailure(ip);
        log.auth.denied({
          provider: "api_key",
          reason: "hash_mismatch",
          prefix: parsed.prefix,
          api_key_id: row.id,
        });
        audit(
          {
            tenant_id: row.tenant_id,
            actor_type: "system",
            action: AuditAction.API_KEY_USED,
            resource_type: "api_key",
            resource_id: row.id,
            result: "denied",
            reason: "hash_mismatch",
            metadata: { prefix: parsed.prefix },
          },
          db,
        );
        return null;
      }

      const now = new Date();
      if (row.revoked_at && row.revoked_at <= now) {
        log.auth.denied({ provider: "api_key", reason: "revoked", api_key_id: row.id });
        audit(
          {
            tenant_id: row.tenant_id,
            actor_type: "system",
            action: AuditAction.AUTH_LOGIN_FAILED,
            resource_type: "api_key",
            resource_id: row.id,
            result: "denied",
            reason: "revoked",
            metadata: { provider: "api_key" },
          },
          db,
        );
        return null;
      }
      if (row.not_before && row.not_before > now) {
        log.auth.denied({ provider: "api_key", reason: "not_yet_active", api_key_id: row.id });
        audit(
          {
            tenant_id: row.tenant_id,
            actor_type: "system",
            action: AuditAction.AUTH_LOGIN_FAILED,
            resource_type: "api_key",
            resource_id: row.id,
            result: "denied",
            reason: "not_yet_active",
            metadata: { provider: "api_key" },
          },
          db,
        );
        return null;
      }
      if (row.expires_at && row.expires_at <= now) {
        log.auth.denied({ provider: "api_key", reason: "expired", api_key_id: row.id });
        audit(
          {
            tenant_id: row.tenant_id,
            actor_type: "system",
            action: AuditAction.AUTH_LOGIN_FAILED,
            resource_type: "api_key",
            resource_id: row.id,
            result: "denied",
            reason: "expired",
            metadata: { provider: "api_key" },
          },
          db,
        );
        return null;
      }
      // Soft revoke after the rotation overlap window has elapsed.
      if (row.rotating_out_at && row.rotating_out_at <= now) {
        log.auth.denied({ provider: "api_key", reason: "rotated_out", api_key_id: row.id });
        audit(
          {
            tenant_id: row.tenant_id,
            actor_type: "system",
            action: AuditAction.AUTH_LOGIN_FAILED,
            resource_type: "api_key",
            resource_id: row.id,
            result: "denied",
            reason: "rotated_out",
            metadata: { provider: "api_key" },
          },
          db,
        );
        return null;
      }

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
            role: users.role,
            email: users.email,
            role_id: users.role_id,
            role_name: rolesTable.name,
          })
          .from(users)
          .leftJoin(rolesTable, eq(rolesTable.id, users.role_id))
          .where(eq(users.id, row.user_id))
          .limit(1);
        const u = userRows[0];
        if (!u) {
          log.auth.denied({
            provider: "api_key",
            reason: "user_missing",
            api_key_id: row.id,
          });
          return null;
        }
        // Prefer the `roles` table lookup so custom tenant roles flow
        // through into the resolved principal. Fall back to the legacy
        // enum for rows predating the RBAC backfill.
        roles = [u.role_name ?? u.role];
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
          })
          .from(systemAccounts)
          .leftJoin(rolesTable, eq(rolesTable.id, systemAccounts.role_id))
          .where(eq(systemAccounts.id, row.system_account_id))
          .limit(1);
        const acct = acctRows[0];
        if (!acct) {
          log.auth.denied({
            provider: "api_key",
            reason: "system_account_missing",
            api_key_id: row.id,
          });
          return null;
        }
        // Pass-2 C7: stop hardcoding `admin`. If the row has no
        // role_id, fall back to `member` — the safer default.
        roles = [acct.role_name ?? "member"];
      } else {
        log.auth.denied({
          provider: "api_key",
          reason: "key_has_no_owner",
          api_key_id: row.id,
        });
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

      log.auth.resolved({
        provider: "api_key",
        principal_kind: kind,
        principal_id: ownerId,
        api_key_id: row.id,
        tenant_id: row.tenant_id,
      });

      await maybeFlushLastUsed(db, row.id, row.tenant_id, row.prefix);

      return principal;
    },
  };
}

// `sql` is intentionally unused right now, but kept imported to allow future
// raw upserts if we move the throttle to a CTE. Suppress unused warning.
void sql;
