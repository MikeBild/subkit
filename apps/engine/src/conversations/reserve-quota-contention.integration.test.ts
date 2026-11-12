import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { hostedQuotaError } from "../db/hosted-quota-errors.ts";
import {
  auditLog,
  conversationMessages,
  conversations,
  conversationTurns,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { provisionSelfServiceTenant } from "../identity/self-service.ts";
import { logger } from "../logging/logger.ts";
import { logRing } from "../observability/log-ring.ts";
import { configureHostedPolicyForTests } from "../test-helpers/hosted-policy.ts";
import { ConversationTurnInProgressError } from "./errors.ts";
import { reserveConversationTurn } from "./turns.ts";

let ctx: TestDb;
let tenantId: string;
beforeAll(async () => {
  ctx = await createTestDb("reserve-quota-contention");
  await configureHostedPolicyForTests(ctx.db, ctx.url);
  const owned = await provisionSelfServiceTenant(
    {
      issuer_url: "https://identity.example.test",
      subject: "reserve-quota-contention",
      email: "reserve-quota-contention@example.test",
      email_verified: true,
    },
    ctx.db,
  );
  tenantId = owned.tenant.id;
});
afterAll(async () => {
  await ctx?.cleanup();
});

async function fixture() {
  const [row] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: tenantId, status: "active" })
    .returning();
  if (!row) throw new Error("conversation fixture missing");
  const holder = await ctx.pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,741937))", [tenantId]);
  let retries = 0;
  let auditLogs = 0;
  let turnLogs = 0;
  const info = logger.info;
  const loggerSpy = spyOn(logger, "info").mockImplementation((entry) => {
    if (
      entry.module === "audit" &&
      entry.action === "conversation.turn_changed" &&
      entry.resource_id === row.id
    )
      auditLogs += 1;
    info(entry);
  });
  let resolveFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const unsubscribe = logRing.subscribe((entry) => {
    if (
      entry.module === "conversation" &&
      entry.action === "turn.changed" &&
      entry.fields.conversation_id === row.id
    )
      turnLogs += 1;
    if (
      entry.module === "db" &&
      entry.action === "retry_transient" &&
      entry.fields.label === "conversation_turn_reserve"
    ) {
      retries += 1;
      resolveFirst();
    }
  });
  return {
    id: row.id,
    holder,
    first,
    unsubscribe: () => {
      unsubscribe();
      loggerSpy.mockRestore();
    },
    retries: () => retries,
    recorded: () => ({ audit: auditLogs, turn: turnLogs }),
  };
}

async function counts(conversationId: string) {
  const where = and(
    eq(conversationTurns.tenant_id, tenantId),
    eq(conversationTurns.conversation_id, conversationId),
  );
  return {
    turns: await ctx.db.select().from(conversationTurns).where(where),
    audits: await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.resource_id, conversationId),
          eq(auditLog.action, "conversation.turn_changed"),
          sql`${auditLog.metadata}->>'state' = 'queued'`,
        ),
      ),
    messages: await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, conversationId)),
  };
}

test("reservation retries a real hosted quota collision and commits exactly one queued turn and audit", async () => {
  const f = await fixture();
  const reservation = reserveConversationTurn(ctx.db, tenantId, f.id);
  const settled = reservation.then(
    (id) => ({ kind: "settled" as const, id }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const witness = await Promise.race([
      f.first.then(() => ({ kind: "retry" as const })),
      settled,
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), 3_000); // allow-wall-clock: failure deadline for a real database event; lock release is event-driven.
      }),
    ]);
    expect(witness.kind).toBe("retry");
    expect(f.recorded()).toEqual({ audit: 0, turn: 0 });
    await f.holder.query("ROLLBACK");
    const result = await settled;
    expect(result.kind).toBe("settled");
    const saved = await counts(f.id);
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]?.state).toBe("queued");
    if (result.kind === "settled") expect(saved.turns[0]?.id).toBe(result.id);
    expect(saved.audits).toHaveLength(1);
    expect(saved.messages).toHaveLength(0);
    expect(f.retries()).toBe(1);
    expect(f.recorded()).toEqual({ audit: 1, turn: 1 });
  } finally {
    if (timer) clearTimeout(timer);
    f.unsubscribe();
    await f.holder.query("ROLLBACK").catch(() => {});
    await settled;
    f.holder.release();
  }
});

test("persistent hosted contention is bounded and leaves no partial reservation or audit", async () => {
  const f = await fixture();
  try {
    let failure: unknown;
    await reserveConversationTurn(ctx.db, tenantId, f.id).catch((error: unknown) => {
      failure = error;
    });
    expect(hostedQuotaError(failure)?.code).toBe("40001");
    expect(f.retries()).toBe(2);
    expect(f.recorded()).toEqual({ audit: 0, turn: 0 });
  } finally {
    f.unsubscribe();
    await f.holder.query("ROLLBACK");
    f.holder.release();
  }
  const saved = await counts(f.id);
  expect(saved.turns).toHaveLength(0);
  expect(saved.audits).toHaveLength(0);
  expect(saved.messages).toHaveLength(0);
});

test("an existing queued turn remains a business conflict without retry or duplicate audit", async () => {
  const f = await fixture();
  try {
    await f.holder.query("ROLLBACK");
    const first = await reserveConversationTurn(ctx.db, tenantId, f.id);
    await expect(reserveConversationTurn(ctx.db, tenantId, f.id)).rejects.toBeInstanceOf(
      ConversationTurnInProgressError,
    );
    const saved = await counts(f.id);
    expect(saved.turns.map((turn) => turn.id)).toEqual([first]);
    expect(saved.audits).toHaveLength(1);
    expect(saved.messages).toHaveLength(0);
    expect(f.retries()).toBe(0);
    expect(f.recorded()).toEqual({ audit: 1, turn: 1 });
  } finally {
    f.unsubscribe();
    await f.holder.query("ROLLBACK").catch(() => {});
    f.holder.release();
  }
});

test("a failure at commit discards success logs and rolls back the queued turn and audit", async () => {
  const f = await fixture();
  try {
    await f.holder.query("ROLLBACK");
    await ctx.db.execute(
      sql.raw(
        "CREATE FUNCTION reserve_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'controlled_reservation_commit_failure'; END $$",
      ),
    );
    await ctx.db.execute(
      sql.raw(
        `CREATE CONSTRAINT TRIGGER reserve_commit_failure AFTER INSERT ON subkit.conversation_turns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.conversation_id = '${f.id}'::uuid) EXECUTE FUNCTION reserve_commit_failure()`,
      ),
    );
    await expect(reserveConversationTurn(ctx.db, tenantId, f.id)).rejects.toMatchObject({
      cause: { code: "23514", message: "controlled_reservation_commit_failure" },
    });
    const saved = await counts(f.id);
    expect(saved.turns).toHaveLength(0);
    expect(saved.audits).toHaveLength(0);
    expect(saved.messages).toHaveLength(0);
    expect(f.retries()).toBe(0);
    expect(f.recorded()).toEqual({ audit: 0, turn: 0 });
  } finally {
    f.unsubscribe();
    await ctx.db.execute(
      sql.raw("DROP TRIGGER IF EXISTS reserve_commit_failure ON subkit.conversation_turns"),
    );
    await ctx.db.execute(sql.raw("DROP FUNCTION IF EXISTS reserve_commit_failure()"));
    f.holder.release();
  }
});
