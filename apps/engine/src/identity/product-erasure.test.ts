import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../audit/index.ts";
import { productSubjectDigest } from "../auth/identity-link.ts";
import { encryptSecret } from "../crypto/index.ts";
import { cockpitInstallations } from "../db/schema/cockpit-installations.ts";
import { cockpitPushSubscriptions } from "../db/schema/cockpit-push.ts";
import {
  apiKeys,
  auditLog,
  callerBudgetUnits,
  executions,
  productIdentityTombstones,
  sessions,
  tasks,
  userIdentities,
  users,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { createTask } from "../tasks/index.ts";
import { taskInput } from "../tasks/tests/fixtures.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { emptyRoleId } from "../test-helpers/roles.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { eraseProductCaller } from "./product-erasure.ts";

let tdb: TestDb;
const nextUuid = createDeterministicUuidFactory(0xe7a5);
const AT = new Date("2030-03-04T05:06:07.000Z");
const EARLIER = new Date("2029-01-01T00:00:00.000Z");
const LATER = new Date("2031-01-01T00:00:00.000Z");
const ISSUER = "https://app-idp.example.test";
const OPERATOR = "00000000-0000-4000-8000-0000000000ee";

beforeAll(async () => {
  tdb = await createTestDb("product-erasure");
  await configureHostedPolicyForTests(tdb.db, tdb.url);
});
afterAll(async () => {
  await tdb.cleanup();
});

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function seedProductUser(tenant_id: string, label: string) {
  const [user] = await tdb.db
    .insert(users)
    .values({
      tenant_id,
      email: `${label}@example.test`,
      display_name: `Person ${label}`,
      role_id: await emptyRoleId(tdb.db, tenant_id),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user fixture missing");
  const subject = `subject-${label}`;
  await tdb.db.insert(userIdentities).values([
    {
      tenant_id,
      user_id: user.id,
      provider_id: "app-sso",
      issuer_url: ISSUER,
      product_id: "app-one",
      subject,
      email: `${label}@example.test`,
    },
    {
      tenant_id,
      user_id: user.id,
      provider_id: "corp-sso",
      issuer_url: "https://corp.example.test",
      subject: `corp-${label}`,
      email: `${label}@example.test`,
    },
  ]);
  await tdb.db.insert(callerBudgetUnits).values({
    tenant_id,
    product_id: "app-one",
    bucket: "runs",
    principal_id: user.id,
    unit_key: `unit-${label}`,
    day: "2030-03-04",
    state: "committed",
    lease_until: LATER,
  });
  const installation_id = nextUuid();
  await tdb.db
    .insert(cockpitInstallations)
    .values({ id: installation_id, tenant_id, owner_user_id: user.id });
  const session_id = nextUuid();
  await tdb.db.insert(sessions).values([
    { id: session_id, tenant_id, user_id: user.id, installation_id, expires_at: LATER },
    { tenant_id, user_id: user.id, expires_at: LATER, revoked_at: EARLIER },
  ]);
  const endpointHash = digest(`endpoint-${label}`);
  await tdb.db.insert(cockpitPushSubscriptions).values({
    tenant_id,
    installation_id,
    session_id,
    endpoint_sha256: endpointHash,
    ...encryptSecret(
      JSON.stringify({ endpoint: `https://push.example.test/${label}`, keys: {} }),
      `cockpit-push-subscription:${tenant_id}:${installation_id}:${session_id}:${endpointHash}`,
    ),
  });
  await tdb.db.insert(apiKeys).values([
    {
      tenant_id,
      user_id: user.id,
      prefix: `live-${label}`,
      token_sha256: digest(`live-${label}`),
      scopes: [],
    },
    {
      tenant_id,
      user_id: user.id,
      prefix: `old-${label}`,
      token_sha256: digest(`old-${label}`),
      scopes: [],
      revoked_at: EARLIER,
    },
  ]);
  const callerContext = {
    tenantId: tenant_id,
    principalId: user.id,
    principalKind: "user" as const,
    provider: "app-sso",
    productId: "app-one",
  };
  const [withSubject, withoutSubject] = await tdb.db
    .insert(executions)
    .values([
      {
        tenant_id,
        status: "succeeded",
        request_source: "api",
        execution_mode: "dev",
        caller_context: { ...callerContext, subject },
      },
      {
        tenant_id,
        status: "succeeded",
        request_source: "api",
        execution_mode: "dev",
        caller_context: callerContext,
      },
    ])
    .returning({ id: executions.id });
  if (!withSubject || !withoutSubject) throw new Error("execution fixture missing");
  return {
    user_id: user.id,
    subject,
    execution_ids: { withSubject: withSubject.id, withoutSubject: withoutSubject.id },
  };
}

function caller(tenantId: string, principalId: string, subject: string) {
  return {
    tenantId,
    principalId,
    principalKind: "user" as const,
    provider: "app-sso",
    productId: "app-one",
    subject,
  };
}

async function snapshot(tenant_id: string, user_id: string) {
  const [user] = await tdb.db
    .select()
    .from(users)
    .where(and(eq(users.tenant_id, tenant_id), eq(users.id, user_id)));
  const identities = await tdb.db
    .select({ provider_id: userIdentities.provider_id })
    .from(userIdentities)
    .where(and(eq(userIdentities.tenant_id, tenant_id), eq(userIdentities.user_id, user_id)));
  const budget = await tdb.db
    .select({ unit_key: callerBudgetUnits.unit_key })
    .from(callerBudgetUnits)
    .where(
      and(eq(callerBudgetUnits.tenant_id, tenant_id), eq(callerBudgetUnits.principal_id, user_id)),
    );
  const sessionRows = await tdb.db
    .select({ revoked_at: sessions.revoked_at })
    .from(sessions)
    .where(and(eq(sessions.tenant_id, tenant_id), eq(sessions.user_id, user_id)));
  const keyRows = await tdb.db
    .select({ revoked_at: apiKeys.revoked_at })
    .from(apiKeys)
    .where(and(eq(apiKeys.tenant_id, tenant_id), eq(apiKeys.user_id, user_id)));
  const push = await tdb.db
    .select({ id: cockpitPushSubscriptions.id })
    .from(cockpitPushSubscriptions)
    .innerJoin(
      cockpitInstallations,
      eq(cockpitInstallations.id, cockpitPushSubscriptions.installation_id),
    )
    .where(
      and(
        eq(cockpitPushSubscriptions.tenant_id, tenant_id),
        eq(cockpitInstallations.owner_user_id, user_id),
      ),
    );
  const times = (rows: Array<{ revoked_at: Date | null }>) =>
    rows.map((row) => row.revoked_at?.getTime() ?? null).sort();
  return {
    user,
    identities: identities.map((row) => row.provider_id).sort(),
    budget: budget.length,
    sessions: times(sessionRows),
    keys: times(keyRows),
    push: push.length,
  };
}

async function callerContextOf(id: string) {
  const [row] = await tdb.db
    .select({ caller_context: executions.caller_context })
    .from(executions)
    .where(eq(executions.id, id));
  return row?.caller_context as Record<string, unknown> | null | undefined;
}

async function tombstones(tenant_id: string) {
  return tdb.db
    .select()
    .from(productIdentityTombstones)
    .where(eq(productIdentityTombstones.tenant_id, tenant_id));
}

async function deletionAudits(tenant_id: string, user_id: string) {
  return tdb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.action, AuditAction.USER_DELETED),
        eq(auditLog.resource_id, user_id),
      ),
    );
}

async function refusalCode(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  const refused = error as { code?: string; message?: string } | null;
  return `${refused?.code}: ${refused?.message}`;
}

describe("erasing a product caller", () => {
  test("a workflow erasure removes the caller's access and personal data", async () => {
    const tenant = await seedTenant(tdb.db);
    const victim = await seedProductUser(tenant.id, "wf-victim");
    const execution_id = nextUuid();

    await eraseProductCaller(tdb.db, caller(tenant.id, victim.user_id, victim.subject), {
      kind: "workflow",
      execution_id,
      now: AT,
    });

    const after = await snapshot(tenant.id, victim.user_id);
    expect(after.identities).toEqual([]);
    expect(after.budget).toBe(0);
    expect(after.sessions).toEqual([EARLIER.getTime(), AT.getTime()].sort());
    expect(after.keys).toEqual([EARLIER.getTime(), AT.getTime()].sort());
    expect(after.push).toBe(0);
    expect(after.user?.status).toBe("disabled");
    expect(after.user?.deleted_at?.getTime()).toBe(AT.getTime());
    expect(after.user?.email).toBe(`erased:${victim.user_id}@invalid`);
    expect(after.user?.display_name).toBeNull();
    expect(await callerContextOf(victim.execution_ids.withSubject)).toMatchObject({
      principalId: victim.user_id,
      subject: null,
    });
    expect(await callerContextOf(victim.execution_ids.withoutSubject)).not.toHaveProperty(
      "subject",
    );
    const [tombstone] = await tombstones(tenant.id);
    expect(tombstone?.provider_id).toBe("app-sso");
    expect(tombstone?.issuer_url).toBe(ISSUER);
    expect(tombstone?.subject_sha256).toBe(productSubjectDigest(victim.subject));
    expect(tombstone?.erased_at.getTime()).toBe(AT.getTime());
    const [event] = await deletionAudits(tenant.id, victim.user_id);
    expect(event?.actor_type).toBe("user");
    expect(event?.actor_id).toBe(victim.user_id);
    expect(event?.resource_type).toBe("user");
    expect(event?.result).toBe("success");
    expect(event?.metadata).toEqual({
      source: "caller_erasure",
      product_id: "app-one",
      provider_id: "app-sso",
      execution_id,
    });
    const [pushEvent] = await tdb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant.id),
          eq(auditLog.action, AuditAction.COCKPIT_PUSH_SUBSCRIPTION_REMOVED),
        ),
      );
    expect(pushEvent?.reason).toBe("erasure");
    expect(pushEvent?.actor_type).toBe("user");
    expect(pushEvent?.actor_id).toBe(victim.user_id);
  });

  test("an operator erasure is attributed to the operator", async () => {
    const tenant = await seedTenant(tdb.db);
    const victim = await seedProductUser(tenant.id, "op-victim");

    await eraseProductCaller(tdb.db, caller(tenant.id, victim.user_id, victim.subject), {
      kind: "operator",
      operator: { kind: "system_account", id: OPERATOR },
      now: AT,
    });

    const [event] = await deletionAudits(tenant.id, victim.user_id);
    expect(event?.actor_type).toBe("system_account");
    expect(event?.actor_id).toBe(OPERATOR);
    expect(event?.metadata).toEqual({
      source: "operator_erasure",
      product_id: "app-one",
      provider_id: "app-sso",
      erased_user_id: victim.user_id,
    });
    const [pushEvent] = await tdb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenant.id),
          eq(auditLog.action, AuditAction.COCKPIT_PUSH_SUBSCRIPTION_REMOVED),
        ),
      );
    expect(pushEvent?.actor_type).toBe("system_account");
    expect(pushEvent?.actor_id).toBe(OPERATOR);
  });

  test("erasure leaves other users of the tenant and the same user id elsewhere untouched", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    const victim = await seedProductUser(tenant.id, "iso-victim");
    const neighbour = await seedProductUser(tenant.id, "iso-neighbour");
    const stranger = await seedProductUser(other.id, "iso-stranger");
    const neighbourBefore = await snapshot(tenant.id, neighbour.user_id);
    const strangerBefore = await snapshot(other.id, stranger.user_id);

    await eraseProductCaller(tdb.db, caller(tenant.id, victim.user_id, victim.subject), {
      kind: "workflow",
      execution_id: nextUuid(),
      now: AT,
    });

    expect(await snapshot(tenant.id, neighbour.user_id)).toEqual(neighbourBefore);
    expect(await snapshot(other.id, stranger.user_id)).toEqual(strangerBefore);
    expect(await callerContextOf(neighbour.execution_ids.withSubject)).toMatchObject({
      subject: neighbour.subject,
    });
    expect(await tombstones(other.id)).toEqual([]);
    expect(await deletionAudits(tenant.id, neighbour.user_id)).toEqual([]);
  });

  test("the erased person's tasks are paused like those of a deactivated person", async () => {
    const tenant = await seedTenant(tdb.db);
    const victim = await seedProductUser(tenant.id, "task-victim");
    const neighbour = await seedProductUser(tenant.id, "task-neighbour");
    const own = (user_id: string) =>
      createTask(
        {
          locale: "de",
          tenant_id: tenant.id,
          principal: {
            provider: "session",
            kind: "user",
            id: user_id,
            tenant_id: tenant.id,
            roles: [],
          },
          input: taskInput({ schedule_cron: "0 7 * * *", schedule_timezone: "Europe/Berlin" }),
        },
        tdb.db,
      );
    const owned = await own(victim.user_id);
    const foreign = await own(neighbour.user_id);

    const followUp = await eraseProductCaller(
      tdb.db,
      caller(tenant.id, victim.user_id, victim.subject),
      { kind: "operator", operator: { kind: "user", id: OPERATOR }, now: AT },
    );
    await followUp(tdb.db);

    const state = async (id: string) => {
      const [row] = await tdb.db
        .select({ paused_at: tasks.paused_at, paused_reason: tasks.paused_reason })
        .from(tasks)
        .where(and(eq(tasks.tenant_id, tenant.id), eq(tasks.id, id)));
      return { paused: row?.paused_at != null, reason: row?.paused_reason ?? null };
    };
    expect(await state(owned.id)).toEqual({ paused: true, reason: "owner_unavailable" });
    expect(await state(foreign.id)).toEqual({ paused: false, reason: null });
  });

  test("an erasure in the wrong tenant changes nothing for the real owner", async () => {
    const tenant = await seedTenant(tdb.db);
    const other = await seedTenant(tdb.db);
    const victim = await seedProductUser(tenant.id, "wrong-tenant-victim");
    const before = await snapshot(tenant.id, victim.user_id);

    await eraseProductCaller(tdb.db, caller(other.id, victim.user_id, victim.subject), {
      kind: "workflow",
      execution_id: nextUuid(),
      now: AT,
    });

    expect(await snapshot(tenant.id, victim.user_id)).toEqual(before);
    expect(await callerContextOf(victim.execution_ids.withSubject)).toMatchObject({
      subject: victim.subject,
    });
    expect(await tombstones(tenant.id)).toEqual([]);
  });

  test("a subject without a stored binding still leaves a tombstone without issuer", async () => {
    const tenant = await seedTenant(tdb.db);
    const victim = await seedProductUser(tenant.id, "unbound-victim");

    await eraseProductCaller(tdb.db, caller(tenant.id, victim.user_id, "subject-unknown"), {
      kind: "workflow",
      execution_id: nextUuid(),
      now: AT,
    });

    const [tombstone] = await tombstones(tenant.id);
    expect(tombstone?.issuer_url).toBe("");
    expect(tombstone?.subject_sha256).toBe(productSubjectDigest("subject-unknown"));
    expect((await snapshot(tenant.id, victim.user_id)).identities).toEqual([]);
  });

  test("erasing the same subject again refreshes its single tombstone", async () => {
    const tenant = await seedTenant(tdb.db);
    const victim = await seedProductUser(tenant.id, "repeat-victim");
    const input = caller(tenant.id, victim.user_id, victim.subject);
    await eraseProductCaller(tdb.db, input, {
      kind: "workflow",
      execution_id: nextUuid(),
      now: AT,
    });

    await eraseProductCaller(tdb.db, input, {
      kind: "workflow",
      execution_id: nextUuid(),
      now: LATER,
    });

    const rows = await tombstones(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.erased_at.getTime()).toBe(LATER.getTime());
    expect(await deletionAudits(tenant.id, victim.user_id)).toHaveLength(2);
  });
});

describe("refusing a product caller erasure", () => {
  const refusals: Array<[string, Record<string, unknown>]> = [
    ["a system account", { principalKind: "system_account" }],
    ["a caller without product", { productId: null }],
    ["a caller without subject", { subject: null }],
    ["a caller with an empty subject", { subject: "" }],
  ];

  for (const [label, overrides] of refusals) {
    test(`${label} is refused and nothing is erased`, async () => {
      const tenant = await seedTenant(tdb.db);
      const victim = await seedProductUser(tenant.id, `refuse-${label.replaceAll(" ", "-")}`);
      const before = await snapshot(tenant.id, victim.user_id);

      const code = await refusalCode(
        eraseProductCaller(
          tdb.db,
          { ...caller(tenant.id, victim.user_id, victim.subject), ...overrides } as Parameters<
            typeof eraseProductCaller
          >[1],
          { kind: "workflow", execution_id: nextUuid(), now: AT },
        ),
      );

      expect(code).toBe(
        "caller_erasure_unavailable: caller erasure needs a product user with a verified subject",
      );
      expect(await snapshot(tenant.id, victim.user_id)).toEqual(before);
      expect(await tombstones(tenant.id)).toEqual([]);
      expect(await deletionAudits(tenant.id, victim.user_id)).toEqual([]);
    });
  }
});
