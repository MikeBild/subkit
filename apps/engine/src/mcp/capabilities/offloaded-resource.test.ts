import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executionFixtures, executions } from "../../db/schema/index.ts";
import { protectExecutionPayload } from "../../execution/sensitive-payload.ts";
import { createExecution } from "../../execution/state.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { readOffloadedExecutionResource } from "./offloaded-resource.ts";

let ctx: EngineTestCtx;
let uri: string;
let executionId: string;
let owner: ResolvedPrincipal;
const body = { secret: "owner-offloaded-result" };

beforeAll(async () => {
  ctx = await createEngineCtx("offloaded-owner-resource");
  owner = {
    tenant_id: ctx.tenantId,
    id: "00000000-0000-4000-8000-000000000093",
    kind: "user",
    provider: "test",
    product_id: "harmoniqs",
    roles: ["admin"],
  };
  const fixture = await ctx.testDb.db
    .insert(executionFixtures)
    .values({ tenant_id: ctx.tenantId, kind: "offload", body })
    .returning({ id: executionFixtures.id });
  if (!fixture[0]) throw new Error("fixture missing");
  uri = `fixture://${fixture[0].id}`;
  executionId = await createExecution(ctx.testDb.db, {
    tenant_id: ctx.tenantId,
    workflow_id: null,
    workflow_version_id: null,
    source_kind: "draft",
    source_ref: null,
    request_source: "api",
    input: null,
    hold_writes: true,
    caller_context: {
      tenantId: ctx.tenantId,
      principalId: owner.id,
      principalKind: "user",
      provider: "test",
      productId: "harmoniqs",
    },
  });
  await ctx.testDb.db
    .update(executions)
    .set({ result_storage_uri: uri })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
}, 30_000);

afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, 30_000);

test("owner can read their offloaded execution resource", async () => {
  const result = await readOffloadedExecutionResource(ctx.testDb.db, owner, uri);
  expect(result).toEqual({ executionId, body });
});

test("another product owner cannot read the resource", async () => {
  await expect(
    readOffloadedExecutionResource(
      ctx.testDb.db,
      {
        ...owner,
        id: "00000000-0000-4000-8000-000000000094",
      },
      uri,
    ),
  ).rejects.toMatchObject({ code: -32002 });
});

test("a generic operator cannot read the product resource", async () => {
  const { product_id: _productId, ...operator } = owner;
  await expect(readOffloadedExecutionResource(ctx.testDb.db, operator, uri)).rejects.toMatchObject({
    code: -32002,
  });
});

test("an offloaded resource with a sensitive result stays private", async () => {
  await ctx.testDb.db
    .update(executions)
    .set({ sensitive_result: protectExecutionPayload(body, ctx.tenantId, executionId, "result") })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
  await expect(readOffloadedExecutionResource(ctx.testDb.db, owner, uri)).rejects.toMatchObject({
    code: -32002,
  });
});
