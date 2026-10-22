import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runMigrations } from "../migrate.ts";
import { auditLog } from "../schema/audit.ts";
import { cockpitInstallations } from "../schema/cockpit-installations.ts";
import { cockpitPushSubscriptions } from "../schema/cockpit-push.ts";
import { sessions, tenants, users } from "../schema/identity.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

const migration = EMBEDDED_MIGRATIONS.find(
  (item) => item.tag === "0143_cockpit_push_revoked_session_cleanup",
);
const nextUuid = createDeterministicUuidFactory(0xc1ea);

test(
  "removes push subscriptions of explicitly revoked sessions and keeps expired ones",
  async () => {
    if (!migration) throw new Error("cockpit push cleanup migration is not embedded");
    const ctx = await createTestDb("cockpit_push_cleanup_migration", {
      upToIdx: migration.idx - 1,
    });
    try {
      const at = new Date(getTestNow());
      const [tenant] = await ctx.db
        .insert(tenants)
        .values({ slug: `push-cleanup-${nextUuid()}`, display_name: "Push cleanup" })
        .returning({ id: tenants.id });
      if (!tenant) throw new Error("missing push cleanup tenant");
      const [user] = await ctx.db
        .insert(users)
        .values({
          tenant_id: tenant.id,
          email: `push-cleanup-${nextUuid()}@test.local`,
          role_id: await builtinRoleId(ctx.db, "member"),
        })
        .returning({ id: users.id });
      if (!user) throw new Error("missing push cleanup user");
      const installationId = nextUuid();
      await ctx.db
        .insert(cockpitInstallations)
        .values({ id: installationId, tenant_id: tenant.id, owner_user_id: user.id });
      const subscription = async (revoked: boolean) => {
        const sessionId = nextUuid();
        await ctx.db.insert(sessions).values({
          id: sessionId,
          tenant_id: tenant.id,
          user_id: user.id,
          installation_id: installationId,
          expires_at: at,
          created_at: at,
          last_seen_at: at,
          revoked_at: revoked ? at : null,
        });
        await ctx.db.insert(cockpitPushSubscriptions).values({
          tenant_id: tenant.id,
          installation_id: installationId,
          session_id: sessionId,
          endpoint_sha256: sessionId.replace(/-/g, ""),
          ciphertext: Buffer.from("cipher"),
          iv: Buffer.from("iv"),
          auth_tag: Buffer.from("tag"),
        });
        return sessionId;
      };
      const loggedOut = await subscription(true);
      const expired = await subscription(true);
      const active = await subscription(false);
      await ctx.db.insert(auditLog).values([
        {
          id: nextUuid(),
          tenant_id: tenant.id,
          actor_type: "user",
          actor_id: user.id,
          action: "session.revoked",
          resource_type: "session",
          resource_id: loggedOut,
          result: "success",
          reason: "logout",
        },
        {
          id: nextUuid(),
          tenant_id: tenant.id,
          actor_type: "system",
          action: "session.revoked",
          resource_type: "session",
          resource_id: expired,
          result: "denied",
          reason: "expired_sliding",
        },
      ]);

      expect((await runMigrations(ctx.db, [migration], true)).applied).toBe(1);

      const remaining = await ctx.db
        .select({ session_id: cockpitPushSubscriptions.session_id })
        .from(cockpitPushSubscriptions)
        .where(eq(cockpitPushSubscriptions.tenant_id, tenant.id));
      expect(remaining.map((row) => row.session_id).sort()).toEqual([active, expired].sort());
      const audits = await ctx.db
        .select({ reason: auditLog.reason, metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenant.id),
            eq(auditLog.action, "cockpit_push.subscription_removed"),
          ),
        );
      expect(audits).toEqual([
        {
          reason: "session_revoked",
          metadata: {
            count: 1,
            installation_ids: [installationId],
            request_source: "migration",
          },
        },
      ]);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
