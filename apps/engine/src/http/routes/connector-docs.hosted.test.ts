import { afterAll, beforeAll, expect, test } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { connectors } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let ctx: HttpTestServer;
let connectorId: string;
beforeAll(async () => {
  ctx = await createHttpTestServer("hosted-docs-boundary", { hosted: true });
  for (const dimension of ["peer", "principal", "tenant", "global"] as const)
    await setConfigKey(`server.hosted_rate_limit.${dimension}_per_minute`, 1000);
  await setConfigKey("server.hosted_rate_limit.tenant_per_month", 10000);
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "hosted-reference",
      display_name: "Hosted reference",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://docs.example.test",
    })
    .returning();
  if (!connector) throw new Error("missing connector");
  connectorId = connector.id;
}, 30_000);
afterAll(async () => {
  if (ctx) await ctx.cleanup();
});
function ingest(body: unknown) {
  return fetch(`${ctx.baseUrl}/v1/connectors/${connectorId}/docs/ingest`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify(body),
  });
}
test("actual hosted HTTP explains credential URL refusal and accepts the inline alternative", async () => {
  const canary = "hosted-http-document-secret-canary";
  const rejected = await ingest({
    source_type: "markdown",
    url: `https://docs.example.test/?api_key=${canary}`,
  });
  expect(rejected.status).toBe(400);
  const rejectedText = await rejected.text();
  expect(rejectedText).toContain("Use a public documentation URL");
  expect(rejectedText).not.toContain(canary);
  const accepted = await ingest({
    source_type: "markdown",
    content: "# Public reference\n\nUseful documentation.",
  });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({
    source_uri: "inline://markdown",
    ingested_count: 1,
  });
});
test("actual hosted HTTP persistence errors cannot expose document content", async () => {
  const canary = "hosted-http-persistence-secret-canary";
  const response = await ingest({
    source_type: "markdown",
    content: `# Reference\n\n${canary}\u0000invalid`,
  });
  expect(response.status).toBe(500);
  const text = await response.text();
  expect(text).not.toContain(canary);
  expect(text).not.toContain("insert into");
});
