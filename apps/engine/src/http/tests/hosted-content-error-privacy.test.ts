import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { getConfig, setConfigKey } from "../../config/loader.ts";
import { conversations } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { logRing } from "../../observability/log-ring.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
beforeAll(async () => {
  resetMockProvider();
  ctx = await createHttpTestServer("hosted-content-error-privacy", { hosted: true });
  for (const key of Object.keys(getConfig().server.hosted_rate_limit))
    await setConfigKey(`server.hosted_rate_limit.${key}`, 10000);
  await setConfigKey("queue.hosted.chat_concurrency", 2);
  await setConfigKey("queue.hosted.execution_concurrency", 2);
  await setConfigKey("queue.hosted.pending_jobs", 10);
  expect(getConfig().llm.provider).toBe("mock");
  const result = await ctx.db.execute<{ bytes: string }>(
    sql`SELECT document#>>'{storage,hosted,tenant_bytes}' AS bytes FROM subkit.runtime_config_revisions WHERE revision=(SELECT active_revision FROM subkit.runtime_config_state WHERE key='runtime')`,
  );
  expect(result.rows[0]?.bytes).toBe("50000000");
});
afterAll(async () => {
  resetMockProvider();
  if (ctx) await ctx.cleanup();
});
function headers(stream = false) {
  return {
    authorization: `Bearer ${ctx.apiKey}`,
    "content-type": "application/json",
    ...(stream ? { accept: "text/event-stream" } : {}),
  };
}
async function assertPrivateFailure(response: Response, canary: string, conversationId?: string) {
  const text = await response.text();
  let stored = "";
  if (conversationId) {
    const [row] = await ctx.db
      .select({ failure: conversations.last_turn_error })
      .from(conversations)
      .where(and(eq(conversations.tenant_id, ctx.tenantId), eq(conversations.id, conversationId)));
    stored = JSON.stringify(row?.failure ?? null);
  }
  const logs = JSON.stringify(logRing.tail({ limit: 1000 }));
  expect({
    responseSafe: !text.includes(canary),
    storedSafe: !stored.includes(canary),
    logsSafe: !logs.includes(canary),
  }).toEqual({ responseSafe: true, storedSafe: true, logsSafe: true });
}
for (const stream of [false, true]) {
  test(`hosted conversation creation ${stream ? "SSE" : "HTTP"} never exposes rejected text parameters`, async () => {
    const canary = `hosted-create-${stream ? "sse" : "http"}-private-canary`;
    logRing.clear();
    const response = await fetch(`${ctx.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: headers(stream),
      body: JSON.stringify({ title: `${canary}\u0000rejected` }),
    });
    expect(response.status).toBe(stream ? 200 : 500);
    await assertPrivateFailure(response, canary);
  });
  test(`hosted conversation append ${stream ? "SSE" : "HTTP"} never echoes rejected message parameters`, async () => {
    const created = await fetch(`${ctx.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "Privacy fixture" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { conversation: { id: string } };
    const conversationId = body.conversation.id;
    const canary = `hosted-append-${stream ? "sse" : "http"}-private-canary`;
    logRing.clear();
    const response = await fetch(`${ctx.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: headers(stream),
      body: JSON.stringify({ message: `${canary}\u0000rejected` }),
    });
    expect(response.status).toBe(stream ? 200 : 500);
    await assertPrivateFailure(response, canary, conversationId);
  });
}
test("hosted knowledge creation never exposes rejected content parameters", async () => {
  const canary = "hosted-knowledge-private-canary";
  logRing.clear();
  const response = await fetch(`${ctx.baseUrl}/v1/knowledge-sources/inline`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      name: "Privacy knowledge fixture",
      slug: "privacy-knowledge-fixture",
      content: `${canary}\u0000rejected`,
    }),
  });
  expect(response.status).toBe(500);
  await assertPrivateFailure(response, canary);
});
