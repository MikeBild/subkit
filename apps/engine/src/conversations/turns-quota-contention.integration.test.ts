import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  conversationMessages,
  conversations,
  conversationTurns,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { logRing } from "../observability/log-ring.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { TEST_WORKSPACE_REGISTRATION } from "../test-helpers/workspace-registration.ts";
import { hasConversationAbort } from "./abort.ts";
import {
  acquireConversationTurn,
  ConversationTurnInProgressError,
  conversationTurnId,
  releaseConversationTurn,
  reserveConversationTurn,
} from "./turns.ts";

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("conversation-turn-quota-contention");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "conversation-turn-quota-contention",
      email: "conversation-turn-quota-contention@example.test",
      email_verified: true,
    },
    TEST_WORKSPACE_REGISTRATION,
    ctx.db,
  );
  tenantId = owned.tenant.id;
});
afterAll(async () => {
  await ctx?.cleanup();
});
async function conversation() {
  const [row] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning();
  if (!row) throw new Error("conversation fixture missing");
  return row.id;
}
async function quotaLock() {
  const client = await ctx.pool.connect();
  await client.query("SELECT pg_advisory_lock(hashtextextended($1::text, 741937))", [tenantId]);
  return client;
}
async function unlock(client: Awaited<ReturnType<typeof quotaLock>>) {
  await client.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 741937))", [tenantId]);
  client.release();
}
async function queuedTurn(conversationId: string, attemptId: string) {
  const turnId = await reserveConversationTurn(ctx.db, tenantId, conversationId);
  await ctx.db
    .update(conversationTurns)
    .set({ attempt_id: attemptId })
    .where(and(eq(conversationTurns.tenant_id, tenantId), eq(conversationTurns.id, turnId)));
  return turnId;
}
function sqlState(error: unknown) {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = Reflect.get(current, "code");
    if (typeof code === "string") return code;
    current = Reflect.get(current, "cause");
  }
  return null;
}
function observeAcquireRetries() {
  let attempts = 0;
  let resolveFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const unsubscribe = logRing.subscribe((entry) => {
    if (
      entry.module === "db" &&
      entry.action === "retry_transient" &&
      entry.fields.label === "conversation_turn_acquire"
    ) {
      attempts += 1;
      if (attempts === 1) resolveFirst();
    }
  });
  return { first, attempts: () => attempts, unsubscribe };
}

test("fresh acquisition retries released hosted contention once and commits one running audit", async () => {
  const conversationId = await conversation();
  const attemptId = "00000000-0000-4000-8000-000000000011";
  const turnId = await queuedTurn(conversationId, attemptId);
  const client = await quotaLock();
  const retries = observeAcquireRetries();
  let locked = true;
  const acquisition = acquireConversationTurn(tenantId, conversationId, ctx.db, {
    turn_id: turnId,
    attempt_id: attemptId,
  });
  let ctrl: Awaited<typeof acquisition> | undefined;
  try {
    await retries.first;
    await unlock(client);
    locked = false;
    ctrl = await acquisition;
    expect(retries.attempts()).toBe(1);
    expect(conversationTurnId(ctrl)).toBe(turnId);
    expect(hasConversationAbort(tenantId, conversationId)).toBe(true);
    const runningAudits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.resource_type, "conversation"),
          eq(auditLog.resource_id, conversationId),
          eq(auditLog.action, "conversation.turn_changed"),
          sql`${auditLog.metadata}->>'turn_id' = ${turnId}`,
          sql`${auditLog.metadata}->>'state' = 'running'`,
        ),
      );
    expect(runningAudits).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversation_id, conversationId)),
    ).toHaveLength(0);
  } finally {
    retries.unsubscribe();
    if (locked) await unlock(client);
    if (ctrl) await releaseConversationTurn(tenantId, conversationId, ctrl);
    else await acquisition.catch(() => {});
  }
});

test("exhausted hosted contention retries release the lease without registering a controller", async () => {
  const conversationId = await conversation();
  const attemptId = "00000000-0000-4000-8000-000000000012";
  const turnId = await queuedTurn(conversationId, attemptId);
  const client = await quotaLock();
  const retries = observeAcquireRetries();
  try {
    let failure: unknown;
    await acquireConversationTurn(tenantId, conversationId, ctx.db, {
      turn_id: turnId,
      attempt_id: attemptId,
    }).catch((error) => {
      failure = error;
    });
    expect(sqlState(failure)).toBe("40001");
    expect(retries.attempts() + 1).toBe(3);
  } finally {
    retries.unsubscribe();
    await unlock(client);
  }
  expect(hasConversationAbort(tenantId, conversationId)).toBe(false);
  const leaseProbe = await ctx.pool.connect();
  try {
    const result = await leaseProbe.query<{ claimed: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS claimed",
      [`conversation-turn:${turnId}`],
    );
    expect(result.rows[0]?.claimed).toBe(true);
    await leaseProbe.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
      `conversation-turn:${turnId}`,
    ]);
  } finally {
    leaseProbe.release();
  }
  expect(await reserveConversationTurn(ctx.db, tenantId, conversationId)).not.toBe(turnId);
});

test("generic SQLSTATE 40001 is not retried by the hosted contention predicate", async () => {
  const conversationId = await conversation();
  const attemptId = "00000000-0000-4000-8000-000000000013";
  const turnId = await queuedTurn(conversationId, attemptId);
  await ctx.db.execute(sql.raw("CREATE SEQUENCE turns_quota_generic_40001_counter"));
  await ctx.db.execute(
    sql.raw(
      "CREATE FUNCTION turns_quota_generic_40001() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('turns_quota_generic_40001_counter'); RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'generic_serialization_test'; END $$;",
    ),
  );
  await ctx.db.execute(
    sql.raw(
      "CREATE TRIGGER turns_quota_generic_40001_trigger BEFORE UPDATE ON subkit.conversation_turns FOR EACH ROW WHEN (NEW.state = 'running') EXECUTE FUNCTION turns_quota_generic_40001();",
    ),
  );
  try {
    let failure: unknown;
    await acquireConversationTurn(tenantId, conversationId, ctx.db, {
      turn_id: turnId,
      attempt_id: attemptId,
    }).catch((error) => {
      failure = error;
    });
    expect(sqlState(failure)).toBe("40001");
    const result = await ctx.db.execute<{ last_value: string }>(
      sql.raw("SELECT last_value::text FROM turns_quota_generic_40001_counter"),
    );
    expect(result.rows[0]?.last_value).toBe("1");
  } finally {
    await ctx.db.execute(
      sql.raw(
        "DROP TRIGGER IF EXISTS turns_quota_generic_40001_trigger ON subkit.conversation_turns",
      ),
    );
    await ctx.db.execute(sql.raw("DROP FUNCTION IF EXISTS turns_quota_generic_40001()"));
    await ctx.db.execute(sql.raw("DROP SEQUENCE IF EXISTS turns_quota_generic_40001_counter"));
  }
  expect(hasConversationAbort(tenantId, conversationId)).toBe(false);
});

test("a stale attempt fence wins over a released contention retry", async () => {
  const conversationId = await conversation();
  const turnId = await queuedTurn(conversationId, "00000000-0000-4000-8000-000000000014");
  const client = await quotaLock();
  const staleAttempt = "00000000-0000-4000-8000-000000000014";
  const currentAttempt = "00000000-0000-4000-8000-000000000015";
  const retries = observeAcquireRetries();
  let locked = true;
  const acquisition = acquireConversationTurn(tenantId, conversationId, ctx.db, {
    turn_id: turnId,
    attempt_id: staleAttempt,
  });
  try {
    await retries.first;
    await ctx.db
      .update(conversationTurns)
      .set({ attempt_id: currentAttempt })
      .where(and(eq(conversationTurns.tenant_id, tenantId), eq(conversationTurns.id, turnId)));
    await unlock(client);
    locked = false;
    await expect(acquisition).rejects.toBeInstanceOf(ConversationTurnInProgressError);
  } finally {
    retries.unsubscribe();
    if (locked) await unlock(client);
    await acquisition.catch(() => {});
  }
  expect(hasConversationAbort(tenantId, conversationId)).toBe(false);
  const [row] = await ctx.db
    .select()
    .from(conversationTurns)
    .where(and(eq(conversationTurns.tenant_id, tenantId), eq(conversationTurns.id, turnId)));
  expect(row?.state).toBe("queued");
  expect(row?.attempt_id).toBe(currentAttempt);
});
