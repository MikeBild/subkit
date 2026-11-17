import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { _drainAuditWritesForTests, audit } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import { setConfigKey } from "../../../config/loader.ts";
import {
  acquireConversationTurn,
  finishConversationTurn,
  releaseConversationTurn,
  reserveConversationTurn,
} from "../../../conversations/turns.ts";
import { auditLog, conversations, conversationTurns } from "../../../db/schema/index.ts";
import { logRing } from "../../../observability/log-ring.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

type Holder = { query: (...args: unknown[]) => Promise<unknown>; release: () => void };

let ctx: HttpTestServer;
beforeAll(async () => {
  ctx = await createHttpTestServer("hosted-quota-contention", { hosted: true });
  for (const dimension of ["peer", "principal", "tenant", "global"] as const)
    await setConfigKey(`server.hosted_rate_limit.${dimension}_per_minute`, 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  const warm = await fetch(`${ctx.baseUrl}/v1/conversations`, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, connection: "close" },
  });
  await warm.text();
  await _drainAuditWritesForTests();
}, 30_000);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

async function holdTenantQuota(): Promise<() => Promise<void>> {
  const holder = (await ctx.testDb.pool.connect()) as unknown as Holder;
  await holder.query("BEGIN");
  await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,741937))", [
    ctx.tenantId,
  ]);
  let held = true;
  return async () => {
    if (!held) return;
    held = false;
    await holder.query("ROLLBACK");
    holder.release();
  };
}

function holdTenantQuotaBefore(fragment: string) {
  const originalQuery = pg.Client.prototype.query;
  const invokeOriginal = (client: pg.Client, args: unknown[]) =>
    (originalQuery as unknown as (...queryArgs: unknown[]) => unknown).apply(client, args);
  let release: (() => Promise<void>) | undefined;
  let observed = false;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]): unknown {
    const statement = args[0];
    const text =
      typeof statement === "string"
        ? statement
        : statement && typeof statement === "object" && "text" in statement
          ? String(statement.text ?? "")
          : "";
    if (observed || !text.includes(fragment)) return invokeOriginal(this, args);
    observed = true;
    return (async () => {
      release = await holdTenantQuota();
      return invokeOriginal(this, args);
    })();
  } as typeof originalQuery;
  return {
    release: async () => {
      if (!release) throw new Error(`tenant quota lock was not acquired before ${fragment}`);
      await release();
    },
    restore: async () => {
      pg.Client.prototype.query = originalQuery;
      await release?.();
    },
  };
}

function observeRetries(label: string) {
  let attempts = 0;
  let resolveFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const unsubscribe = logRing.subscribe((entry) => {
    if (
      entry.module === "db" &&
      entry.action === "retry_transient" &&
      entry.fields.label === label
    ) {
      attempts += 1;
      if (attempts === 1) resolveFirst();
    }
  });
  return { first, attempts: () => attempts, unsubscribe };
}

function createConversation(title: string) {
  return fetch(`${ctx.baseUrl}/v1/conversations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify({ title }),
  });
}

async function settledBeforeRetry(
  retried: Promise<void>,
  response: Promise<Response>,
): Promise<string | null> {
  return Promise.race([
    retried.then(() => null),
    response.then(async (settled) => `${settled.status} ${await settled.clone().text()}`),
  ]);
}

test("creating a conversation waits out a busy workspace quota and stores it exactly once", async () => {
  const title = "Contended conversation create";
  const contention = holdTenantQuotaBefore('insert into "conversations"');
  const retries = observeRetries("conversation_create_hosted_quota");
  try {
    const response = createConversation(title);
    expect(await settledBeforeRetry(retries.first, response)).toBeNull();
    await contention.release();
    const settled = await response;
    const body = await settled.text();
    expect(settled.status, body).toBe(201);
    expect(retries.attempts()).toBe(1);
    const rows = await ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, ctx.tenantId), eq(conversations.title, title)));
    expect(rows).toHaveLength(1);
    const created = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, AuditAction.CONVERSATION_CREATED),
          eq(auditLog.resource_id, rows[0]?.id ?? ""),
        ),
      );
    expect(created).toHaveLength(1);
  } finally {
    retries.unsubscribe();
    await contention.restore();
  }
});

async function conversationWithQueuedTurn(title: string) {
  const [conversation] = await ctx.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenantId, status: "active", owner_id: ctx.userId, title })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("missing conversation");
  const turnId = await reserveConversationTurn(ctx.db, ctx.tenantId, conversation.id);
  return { conversationId: conversation.id, turnId };
}

test("finishing a turn waits out a busy workspace quota and records the state with one audit entry", async () => {
  const { conversationId, turnId } = await conversationWithQueuedTurn("Contended turn finish");
  const release = await holdTenantQuota();
  const retries = observeRetries("conversation_turn_finish_hosted_quota");
  try {
    const finished = finishConversationTurn(ctx.db, ctx.tenantId, conversationId, turnId, "failed");
    const early = await Promise.race([
      retries.first.then(() => null),
      finished.then(
        () => "finished",
        (error) => String(error),
      ),
    ]);
    expect(early).toBeNull();
    await release();
    await finished;
    expect(retries.attempts()).toBe(1);
    const [turn] = await ctx.db
      .select({ state: conversationTurns.state })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turnId));
    expect(turn?.state).toBe("failed");
    const changes = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, AuditAction.CONVERSATION_TURN_CHANGED),
          eq(auditLog.resource_id, conversationId),
        ),
      );
    expect(
      changes.filter((change) => (change.metadata as { state?: string }).state === "failed"),
    ).toHaveLength(1);
  } finally {
    retries.unsubscribe();
    await release();
  }
});

test("releasing a turn never raises while the workspace quota stays busy and keeps the conversation usable", async () => {
  const [conversation] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenantId,
      status: "active",
      owner_id: ctx.userId,
      title: "Contended turn release",
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("missing conversation");
  const states = async () =>
    (
      await ctx.db
        .select({ state: conversationTurns.state })
        .from(conversationTurns)
        .where(eq(conversationTurns.conversation_id, conversation.id))
    ).map((turn) => turn.state);
  const first = await acquireConversationTurn(ctx.tenantId, conversation.id, ctx.db);
  const release = await holdTenantQuota();
  const retries = observeRetries("conversation_turn_finish_hosted_quota");
  try {
    await releaseConversationTurn(ctx.tenantId, conversation.id, first, "completed");
    expect(retries.attempts()).toBe(2);
    expect(await states()).toEqual(["completed"]);
    await release();
    const next = await acquireConversationTurn(ctx.tenantId, conversation.id, ctx.db);
    await releaseConversationTurn(ctx.tenantId, conversation.id, next, "completed");
    expect(await states()).toEqual(["completed", "completed"]);
  } finally {
    retries.unsubscribe();
    await release();
  }
});

test("a detached audit entry survives a busy workspace quota", async () => {
  const release = await holdTenantQuota();
  const retries = observeRetries("detached_audit_hosted_quota");
  try {
    const entry = audit(
      {
        tenant_id: ctx.tenantId,
        actor_type: "system",
        action: AuditAction.API_KEY_USED,
        resource_type: "api_key",
        resource_id: "contended-detached-audit",
        result: "success",
      },
      ctx.db,
    );
    const lost = await Promise.race([
      retries.first.then(() => false),
      _drainAuditWritesForTests(ctx.db).then(() => true),
    ]);
    expect(lost).toBe(false);
    await release();
    await _drainAuditWritesForTests(ctx.db);
    expect(retries.attempts()).toBe(1);
    const rows = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.id, entry.id)));
    expect(rows).toHaveLength(1);
  } finally {
    retries.unsubscribe();
    await release();
  }
});
