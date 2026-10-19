import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { setConfigKey } from "../../../config/loader.ts";
import {
  conversationMessages,
  conversations,
  hostedTenantUsage,
} from "../../../db/schema/index.ts";
import { tenantWorkSnapshot } from "../../../execution/index.ts";
import { getMockProvider } from "../../../llm/mock-provider.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;
let conversationId: string;
beforeAll(async () => {
  ctx = await createHttpTestServer("hosted-chat-content-quota", { hosted: true });
  for (const dimension of ["peer", "principal", "tenant", "global"] as const)
    await setConfigKey(`server.hosted_rate_limit.${dimension}_per_minute`, 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
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
function append(accept: string) {
  return fetch(`${ctx.baseUrl}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
      accept,
      connection: "close",
    },
    body: JSON.stringify({
      message: "A synthetic message that cannot fit in the exhausted allowance.",
    }),
  });
}
test("direct HTTP and SSE chat explain the shared content allowance before a provider call", async () => {
  const json = await append("application/json");
  expect(json.status).toBe(429);
  expect(await json.json()).toMatchObject({ code: "hosted_storage_quota_exhausted" });
  const stream = await append("text/event-stream");
  expect(stream.status).toBe(200);
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
