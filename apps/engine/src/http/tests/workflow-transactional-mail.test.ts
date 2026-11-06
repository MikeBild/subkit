import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { apiKeys, transactionalMailReceipts, workflows } from "../../db/schema/index.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let workflow: string;
let foreignWorkflow: string;
const requestId = "00000000-0000-4000-8000-000000000001";
const deniedKey = "wf_live_no_receipts_test_key_000000001";
beforeAll(async () => {
  ctx = await createHttpTestServer("transactional_mail_receipts");
  const [own] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenantId, slug: "own", name: "Own", lifecycle: "draft" })
    .returning();
  const otherTenant = await seedTenant(ctx.db, { display_name: "Other", slug: "other" });
  if (!own || !otherTenant) throw new Error("missing fixture");
  const [other] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: otherTenant.id, slug: "other", name: "Other", lifecycle: "draft" })
    .returning();
  if (!other) throw new Error("missing fixture");
  workflow = own.id;
  foreignWorkflow = other.id;
  await ctx.db.insert(transactionalMailReceipts).values([
    {
      tenant_id: ctx.tenantId,
      workflow_id: workflow,
      request_id: requestId,
      execution_id: requestId,
      step_id: "reply",
      state: "delivery_unknown",
    },
    {
      tenant_id: otherTenant.id,
      workflow_id: foreignWorkflow,
      request_id: requestId,
      execution_id: requestId,
      step_id: "reply",
      state: "sent",
    },
  ]);
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    prefix: deniedKey.slice(0, 12),
    token_sha256: createHash("sha256").update(deniedKey).digest("hex"),
    scopes: ["skill:read"],
  });
});
afterAll(async () => {
  await ctx?.cleanup();
});
const get = (id = workflow, query = "", key = ctx.apiKey) =>
  fetch(`${ctx.baseUrl}/v1/workflows/${id}/transactional-mail-receipts${query}`, {
    headers: { authorization: `Bearer ${key}` },
  });

test("receipts expose durable outcome and IDs without contact or message contents", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ request_id: requestId, state: "delivery_unknown" });
  expect(Object.keys(body.items[0]).sort()).toEqual([
    "created_at",
    "execution_id",
    "request_id",
    "state",
    "step_id",
    "updated_at",
  ]);
  expect((await get(workflow, "?offset=1")).status).toBe(200);
  expect(await (await get(workflow, "?offset=1")).json()).toEqual({ items: [] });
});
test("receipt reads enforce tenant, workflow permission and bounded pagination", async () => {
  expect((await get(foreignWorkflow)).status).toBe(404);
  expect((await get(workflow, "", deniedKey)).status).toBe(403);
  expect((await get(workflow, "?limit=201")).status).toBe(400);
  expect((await get(workflow, "?offset=-1")).status).toBe(400);
});
