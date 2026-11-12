import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { setConfigKey } from "../../../config/loader.ts";
import {
  conversationMessages,
  conversations,
  conversationTurns,
  hostedTenantUsage,
} from "../../../db/schema/index.ts";
import { tenantWorkSnapshot } from "../../../execution/index.ts";
import { getMockProvider } from "../../../llm/mock-provider.ts";
import { logRing } from "../../../observability/log-ring.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;
let conversationId: string;
beforeAll(async () => {
  ctx = await createHttpTestServer("hosted-chat-content-quota", { hosted: true });
  for (const dimension of ["peer", "principal", "tenant", "global"] as const)
    await setConfigKey(`server.hosted_rate_limit.${dimension}_per_minute`, 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  await setConfigKey("queue.hosted.execution_concurrency", 1);
  await setConfigKey("queue.hosted.chat_concurrency", 1);
  await setConfigKey("queue.hosted.pending_jobs", 1);
  const [conversation] = await ctx.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenantId,
      status: "active",
      owner_id: ctx.userId,
      title: "Hosted content quota",
    })
    .returning();
  if (!conversation) throw new Error("missing conversation");
  conversationId = conversation.id;
  const [usage] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, ctx.tenantId));
  if (!usage) throw new Error("missing usage");
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${usage.logical_bytes.toString()}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  getMockProvider().reset();
}, 30_000);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
function append(
  accept: string,
  message = "A synthetic message that cannot fit in the exhausted allowance.",
) {
  return fetch(`${ctx.baseUrl}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
      accept,
      connection: "close",
    },
    body: JSON.stringify({
      message,
    }),
  });
}
function holdQuotaBeforeFirstConversationMessageInsert() {
  type Holder = {
    query: (...args: unknown[]) => Promise<unknown>;
    release: () => void;
  };
  const originalQuery = pg.Client.prototype.query;
  const invokeOriginal = (client: pg.Client, args: unknown[]) =>
    (originalQuery as unknown as (...queryArgs: unknown[]) => unknown).apply(client, args);
  let holder: Holder | undefined;
  let observed = false;
  const queryWithMessageLock = function (this: pg.Client, ...args: unknown[]): unknown {
    const statement = args[0];
    const text =
      typeof statement === "string"
        ? statement
        : statement && typeof statement === "object" && "text" in statement
          ? String(statement.text ?? "")
          : "";
    if (!observed && text.includes('insert into "conversation_messages"')) {
      return (async () => {
        if (!observed) {
          holder = (await ctx.testDb.pool.connect()) as unknown as Holder;
          await holder.query("BEGIN");
          await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,741937))", [
            ctx.tenantId,
          ]);
          observed = true;
        }
        return invokeOriginal(this, args);
      })();
    }
    return invokeOriginal(this, args);
  } as typeof originalQuery;
  pg.Client.prototype.query = queryWithMessageLock;
  return {
    observed: () => observed,
    release: async () => {
      if (!holder) throw new Error("conversation message quota lock was not acquired");
      await holder.query("ROLLBACK");
      holder.release();
      holder = undefined;
    },
    restore: () => {
      pg.Client.prototype.query = originalQuery;
    },
  };
}
function observeContentWriteRetry() {
  let attempts = 0;
  let resolveFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const unsubscribe = logRing.subscribe((entry) => {
    if (
      entry.module === "db" &&
      entry.action === "retry_transient" &&
      entry.fields.label === "conversation_message_hosted_quota"
    ) {
      attempts += 1;
      if (attempts === 1) resolveFirst();
    }
  });
  return {
    first,
    attempts: () => attempts,
    unsubscribe,
  };
}
test("HTTP and SSE requests reject exhausted content allowance before opening a stream or calling a provider", async () => {
  const json = await append("application/json");
  expect(json.status).toBe(429);
  expect(await json.json()).toMatchObject({ code: "hosted_storage_quota_exhausted" });
  const stream = await append("text/event-stream");
  expect(stream.status).toBe(429);
  const frames = await stream.text();
  expect(frames).toContain('"code":"hosted_storage_quota_exhausted"');
  expect(frames).not.toContain('"code":"internal"');
  expect(frames).not.toContain("insert into");
  expect(getMockProvider().calls).toHaveLength(0);
  expect(tenantWorkSnapshot(ctx.tenantId).in_flight).toBe(0);
  expect(
    await ctx.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, ctx.tenantId),
          eq(conversationMessages.conversation_id, conversationId),
        ),
      ),
  ).toHaveLength(0);
});
test("retries a fresh content write after transient hosted quota contention without calling a provider", async () => {
  const [usage] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, ctx.tenantId));
  if (!usage) throw new Error("missing usage");
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${(usage.logical_bytes + 2048n).toString()}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  const contention = holdQuotaBeforeFirstConversationMessageInsert();
  const retries = observeContentWriteRetry();
  let released = false;
  let witnessTimer: ReturnType<typeof setTimeout> | undefined;
  let responsePromise: Promise<Response> | undefined;
  try {
    responsePromise = append("application/json", "x".repeat(10_000));
    const witness = await Promise.race([
      retries.first.then(() => ({ kind: "retry" as const })),
      responsePromise.then(
        async (response) => ({
          kind: "response" as const,
          status: response.status,
          body: await response.clone().text(),
        }),
        (error) => ({ kind: "error" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        witnessTimer = setTimeout(() => resolve({ kind: "timeout" }), 5_000); // allow-wall-clock: failure deadline for a real database event; lock release is event-driven.
      }),
    ]);
    if (witnessTimer) clearTimeout(witnessTimer);
    if (witness.kind === "response")
      throw new Error(`content retry witness settled early: ${witness.status} ${witness.body}`);
    if (witness.kind === "error") throw witness.error;
    if (witness.kind === "timeout") throw new Error("content retry witness timed out before retry");
    await contention.release();
    released = true;
    const response = await responsePromise;
    const body = await response.text();
    expect(response.status, body).toBe(429);
    expect(JSON.parse(body)).toMatchObject({ code: "hosted_storage_quota_exhausted" });
    expect(retries.attempts()).toBe(1);
    expect(contention.observed()).toBe(true);
    expect(getMockProvider().calls).toHaveLength(0);
    expect(
      await ctx.db
        .select()
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.tenant_id, ctx.tenantId),
            eq(conversationMessages.conversation_id, conversationId),
          ),
        ),
    ).toHaveLength(0);
  } finally {
    if (witnessTimer) clearTimeout(witnessTimer);
    retries.unsubscribe();
    if (!released) await contention.release().catch(() => {});
    contention.restore();
    await responsePromise?.catch(() => {});
  }
});
test("retries a permitted content write exactly once without duplicating its message, title, or completed turn", async () => {
  const [usage] = await ctx.db
    .select()
    .from(hostedTenantUsage)
    .where(eq(hostedTenantUsage.tenant_id, ctx.tenantId));
  if (!usage) throw new Error("missing usage");
  await ctx.db.execute(
    sql`UPDATE subkit.runtime_config_revisions SET document=jsonb_set(document,'{storage,hosted,tenant_bytes}',to_jsonb(${(usage.logical_bytes + 1_000_000n).toString()}::text)) WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  const message = "A message that fits in the restored allowance.";
  await ctx.db
    .update(conversations)
    .set({ title: null })
    .where(and(eq(conversations.tenant_id, ctx.tenantId), eq(conversations.id, conversationId)));
  const completedTurnsBefore = await ctx.db
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, ctx.tenantId),
        eq(conversationTurns.conversation_id, conversationId),
        eq(conversationTurns.state, "completed"),
      ),
    );
  getMockProvider().reset();
  const contention = holdQuotaBeforeFirstConversationMessageInsert();
  const retries = observeContentWriteRetry();
  let released = false;
  let witnessTimer: ReturnType<typeof setTimeout> | undefined;
  let responsePromise: Promise<Response> | undefined;
  try {
    responsePromise = append("application/json", message);
    const witness = await Promise.race([
      retries.first.then(() => ({ kind: "retry" as const })),
      responsePromise.then(
        async (response) => ({
          kind: "response" as const,
          status: response.status,
          body: await response.clone().text(),
        }),
        (error) => ({ kind: "error" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        witnessTimer = setTimeout(() => resolve({ kind: "timeout" }), 5_000); // allow-wall-clock: failure deadline for a real database event; lock release is event-driven.
      }),
    ]);
    if (witnessTimer) clearTimeout(witnessTimer);
    if (witness.kind === "response")
      throw new Error(`content retry witness settled early: ${witness.status} ${witness.body}`);
    if (witness.kind === "error") throw witness.error;
    if (witness.kind === "timeout") throw new Error("content retry witness timed out before retry");
    await contention.release();
    released = true;
    const response = await responsePromise;
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(retries.attempts()).toBe(1);
    expect(contention.observed()).toBe(true);
    expect(getMockProvider().calls).toHaveLength(1);
    const messages = await ctx.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, ctx.tenantId),
          eq(conversationMessages.conversation_id, conversationId),
          eq(conversationMessages.role, "user"),
        ),
      );
    expect(messages).toHaveLength(1);
    const [conversation] = await ctx.db
      .select({ title: conversations.title })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, ctx.tenantId), eq(conversations.id, conversationId)));
    expect(conversation?.title).toBe(message);
    const completedTurns = await ctx.db
      .select()
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.tenant_id, ctx.tenantId),
          eq(conversationTurns.conversation_id, conversationId),
          eq(conversationTurns.state, "completed"),
        ),
      );
    expect(completedTurns).toHaveLength(completedTurnsBefore.length + 1);
    expect(tenantWorkSnapshot(ctx.tenantId).in_flight).toBe(0);
  } finally {
    if (witnessTimer) clearTimeout(witnessTimer);
    retries.unsubscribe();
    if (!released) await contention.release().catch(() => {});
    contention.restore();
    await responsePromise?.catch(() => {});
  }
});
