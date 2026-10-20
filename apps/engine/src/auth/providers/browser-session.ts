import { and, eq } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { type Db, getDb } from "../../db/client.ts";
import { cockpitInstallations } from "../../db/schema/cockpit-installations.ts";
import { roles, sessions, users } from "../../db/schema/index.ts";
import { log, logger } from "../../logging/logger.ts";
import { browserSessionFromRequest, SESSION_SLIDING_TTL_MS } from "../browser-session.ts";
import type { AuthProvider, ResolvedPrincipal } from "../types.ts";

export interface BrowserSessionProviderOptions {
  db?: Db;
}

export function createBrowserSessionProvider(
  opts: BrowserSessionProviderOptions = {},
): AuthProvider {
  return {
    name: "browser_session",
    capabilities: {
      human: true,
      machine: false,
      interactive: false,
      refresh: false,
      revoke: true,
    },
    async resolve(req: Request): Promise<ResolvedPrincipal | null> {
      const payload = await browserSessionFromRequest(req);
      if (!payload) return null;

      const db = opts.db ?? getDb();
      // tenant-filter:exempt — session lookup by id resolves the tenant.
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, payload.session_id))
        .limit(1);
      if (!row) {
        log.auth.denied({ provider: "browser_session", reason: "session_not_found" });
        return null;
      }

      if (row.installation_id !== (payload.installation_id ?? null)) {
        log.auth.denied({ provider: "browser_session", reason: "installation_mismatch" });
        return null;
      }
      if (row.installation_id) {
        const [installation] = await db
          .select({
            id: cockpitInstallations.id,
            tenant_id: cockpitInstallations.tenant_id,
            owner_user_id: cockpitInstallations.owner_user_id,
            revoked_at: cockpitInstallations.revoked_at,
          })
          .from(cockpitInstallations)
          .where(
            and(
              eq(cockpitInstallations.id, row.installation_id),
              eq(cockpitInstallations.tenant_id, row.tenant_id),
            ),
          )
          .limit(1);
        if (
          !installation ||
          installation.revoked_at ||
          installation.tenant_id !== row.tenant_id ||
          installation.owner_user_id !== row.user_id
        ) {
          log.auth.denied({ provider: "browser_session", reason: "installation_not_active" });
          return null;
        }
      }

      const now = new Date();
      const denyReason: "revoked" | "expired_absolute" | "expired_sliding" | null = row.revoked_at
        ? "revoked"
        : row.absolute_expires_at && row.absolute_expires_at.getTime() <= now.getTime()
          ? "expired_absolute"
          : row.last_seen_at && now.getTime() - row.last_seen_at.getTime() > SESSION_SLIDING_TTL_MS
            ? "expired_sliding"
            : null;

      if (denyReason) {
        await auditAwait(
          {
            tenant_id: row.tenant_id,
            actor_type: "system",
            actor_id: row.user_id,
            action: AuditAction.SESSION_REVOKED,
            resource_type: "session",
            resource_id: row.id,
            result: "denied",
            reason: denyReason,
            metadata: { via: "browser_session_resolve" },
          },
          db,
        );
        return null;
      }

      void Promise.resolve().then(() => {
        db.update(sessions)
          .set({ last_seen_at: new Date() })
          .where(eq(sessions.id, row.id))
          .catch((err) => {
            logger.warn({
              module: "auth",
              action: "browser_session.last_seen_flush_failed",
              msg: "failed to bump sessions.last_seen_at",
              session_id: row.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      });

      const [u] = await db
        .select({
          role_name: roles.name,
          email: users.email,
          status: users.status,
          deleted_at: users.deleted_at,
        })
        .from(users)
        .leftJoin(roles, eq(roles.id, users.role_id))
        .where(and(eq(users.tenant_id, row.tenant_id), eq(users.id, row.user_id)))
        .limit(1);
      if (u?.status !== "active" || u.deleted_at !== null) {
        log.auth.denied({ provider: "browser_session", reason: "user_not_active" });
        return null;
      }

      const principal: ResolvedPrincipal = {
        provider: "browser_session",
        kind: "user",
        id: row.user_id,
        tenant_id: row.tenant_id,
        roles: u.role_name ? [u.role_name] : [],
        session_id: row.id,
        ...(row.installation_id ? { installation_id: row.installation_id } : {}),
        auth_source: { kind: "browser_session", session_id: row.id },
      };
      if (row.product_id) principal.product_id = row.product_id;
      if (u.email) principal.email = u.email;

      log.auth.resolved({
        provider: "browser_session",
        principal_kind: "user",
        principal_id: row.user_id,
        tenant_id: row.tenant_id,
        session_id: row.id,
      });

      return principal;
    },
  };
}
