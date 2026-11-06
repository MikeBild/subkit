import { expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import type { Db } from "../client.ts";
import { cockpitInstallations } from "../schema/cockpit-installations.ts";
import { cockpitPushSubscriptions } from "../schema/cockpit-push.ts";
import { sessions, tenants, users } from "../schema/identity.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "../tests/setup.ts";

const nextUuid = createDeterministicUuidFactory(0xb40e);

async function violation(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? (error as { constraint?: string }).constraint;
  }
}

async function tenantWithUser(db: Db) {
  const [tenant] = await db
    .insert(tenants)
    .values({ slug: `push-browser-migration-${nextUuid()}`, display_name: "Push migration" })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("missing push migration tenant");
  const [user] = await db
    .insert(users)
    .values({
      tenant_id: tenant.id,
      email: `push-browser-migration-${nextUuid()}@test.local`,
      role_id: await builtinRoleId(db, "member"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("missing push migration user");
  return { tenantId: tenant.id, userId: user.id };
}

test(
  "a subscription without kind is an installation row and browser rows stay bounded",
  async () => {
    const ctx = await createTestDb("cockpit_push_browser_migration");
    try {
      const at = new Date(getTestNow());
      const first = await tenantWithUser(ctx.db);
      const second = await tenantWithUser(ctx.db);
      const installationId = nextUuid();
      await ctx.db
        .insert(cockpitInstallations)
        .values({ id: installationId, tenant_id: first.tenantId, owner_user_id: first.userId });
      const session = async (tenantId: string, userId: string, installation: string | null) => {
        const id = nextUuid();
        await ctx.db.insert(sessions).values({
          id,
          tenant_id: tenantId,
          user_id: userId,
          installation_id: installation,
          expires_at: at,
          created_at: at,
          last_seen_at: at,
        });
        return id;
      };
      const installedSession = await session(first.tenantId, first.userId, installationId);
      await ctx.db.execute(sql`
        insert into cockpit_push_subscriptions
          (tenant_id, installation_id, session_id, endpoint_sha256, ciphertext, iv, auth_tag)
        values (${first.tenantId}, ${installationId}, ${installedSession}, 'installed',
          '\\x00'::bytea, '\\x00'::bytea, '\\x00'::bytea)`);

      const existing = await ctx.db
        .select({
          kind: cockpitPushSubscriptions.kind,
          user_id: cockpitPushSubscriptions.user_id,
          device_sha256: cockpitPushSubscriptions.device_sha256,
        })
        .from(cockpitPushSubscriptions)
        .where(eq(cockpitPushSubscriptions.tenant_id, first.tenantId));
      expect(existing).toEqual([{ kind: "installation", user_id: null, device_sha256: null }]);

      const rootSession = await session(first.tenantId, first.userId, null);
      const row = (input: Partial<typeof cockpitPushSubscriptions.$inferInsert>) => ({
        tenant_id: first.tenantId,
        session_id: rootSession,
        endpoint_sha256: "browser",
        ciphertext: Buffer.from("cipher"),
        iv: Buffer.from("iv"),
        auth_tag: Buffer.from("tag"),
        ...input,
      });
      expect(
        await violation(() =>
          ctx.db
            .insert(cockpitPushSubscriptions)
            .values(
              row({ kind: "browser", installation_id: installationId, user_id: first.userId }),
            ),
        ),
      ).toBe("cockpit_push_subscriptions_kind_check");
      expect(
        await violation(() =>
          ctx.db
            .insert(cockpitPushSubscriptions)
            .values(row({ kind: "installation", user_id: first.userId })),
        ),
      ).toBe("cockpit_push_subscriptions_kind_check");
      expect(
        await violation(() =>
          ctx.db
            .insert(cockpitPushSubscriptions)
            .values(row({ kind: "browser", user_id: first.userId })),
        ),
      ).toBeUndefined();
      expect(
        await violation(() =>
          ctx.db
            .insert(cockpitPushSubscriptions)
            .values(row({ kind: "browser", user_id: first.userId })),
        ),
      ).toBe("cockpit_push_subscriptions_browser_endpoint_key");
      const secondSession = await session(second.tenantId, second.userId, null);
      expect(
        await violation(() =>
          ctx.db.insert(cockpitPushSubscriptions).values(
            row({
              tenant_id: second.tenantId,
              session_id: secondSession,
              kind: "browser",
              user_id: second.userId,
            }),
          ),
        ),
      ).toBeUndefined();
      const browserRows = await ctx.db
        .select({ id: cockpitPushSubscriptions.id })
        .from(cockpitPushSubscriptions)
        .where(
          and(
            eq(cockpitPushSubscriptions.tenant_id, first.tenantId),
            eq(cockpitPushSubscriptions.kind, "browser"),
          ),
        );
      expect(browserRows).toHaveLength(1);
    } finally {
      await ctx.cleanup();
    }
  },
  TEST_DB_HOOK_TIMEOUT,
);
