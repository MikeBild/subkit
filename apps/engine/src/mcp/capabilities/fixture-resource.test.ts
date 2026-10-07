import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { executionFixtures, executions } from "../../db/schema/index.ts";
import { createExecution } from "../../execution/state.ts";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { PubSubEmitter } from "../../pubsub/emitter.ts";
import { registerResourcesCapability } from "./resources.ts";

let ctx: EngineTestCtx;
let owner: ResolvedPrincipal;
let linkedUri: string;
let sensitiveUri: string;
let offloadedUri: string;
let unboundUri: string;
const secret = "private-product-fixture-canary";

beforeAll(async () => {
  ctx = await createEngineCtx("fixture-owner-resource");
  owner = {
    tenant_id: ctx.tenantId,
    id: "00000000-0000-4000-8000-000000000095",
    kind: "user",
    provider: "test",
    product_id: "harmoniqs",
    roles: ["admin"],
  };
  async function execution(sensitive = false) {
    return createExecution(ctx.testDb.db, {
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
        principalKind: owner.kind,
        provider: owner.provider,
        productId: "harmoniqs",
      },
      ...(sensitive ? { execution_privacy: "sensitive" } : {}),
    });
  }
  const executionId = await execution();
  const sensitiveId = await execution(true);
  async function fixture(kind: string, execution_id: string | null) {
    const [row] = await ctx.testDb.db
      .insert(executionFixtures)
      .values({ tenant_id: ctx.tenantId, kind, execution_id, body: { secret } })
      .returning({ id: executionFixtures.id });
    if (!row) throw new Error("fixture missing");
    return `fixture://${row.id}`;
  }
  linkedUri = await fixture("fixture", executionId);
  sensitiveUri = await fixture("fixture", sensitiveId);
  offloadedUri = await fixture("offload", null);
  unboundUri = await fixture("fixture", null);
  await ctx.testDb.db
    .update(executions)
    .set({ result_storage_uri: offloadedUri })
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, executionId)));
}, 30_000);

afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, 30_000);

async function read(principal: ResolvedPrincipal, uri: string) {
  const server = new Server({ name: "fixture-resource-test", version: "0.0.0" });
  registerResourcesCapability({
    server,
    db: ctx.testDb.db,
    principal,
    emitter: new PubSubEmitter(),
  });
  const client = new Client({ name: "fixture-resource-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    return await client.readResource({ uri });
  } finally {
    await client.close();
    await server.close();
  }
}

function operator() {
  const { product_id: _product, ...principal } = owner;
  return principal;
}

test("owner reads linked fixture through actual MCP resource handler", async () => {
  expect(JSON.stringify(await read(owner, linkedUri))).toContain(secret);
});

for (const kind of ["other_owner", "generic_operator", "other_kind"] as const) {
  test(`linked fixture refuses ${kind}`, async () => {
    const principal =
      kind === "generic_operator"
        ? operator()
        : kind === "other_kind"
          ? { ...owner, kind: "system_account" as const }
          : { ...owner, id: "00000000-0000-4000-8000-000000000096" };
    await expect(read(principal, linkedUri)).rejects.toMatchObject({ code: -32002 });
  });
}

test("sensitive fixture refuses even its owner before payload read", async () => {
  await expect(read(owner, sensitiveUri)).rejects.toMatchObject({ code: -32002 });
});

test("offload backlink without fixture execution id still enforces product ownership", async () => {
  expect(JSON.stringify(await read(owner, offloadedUri))).toContain(secret);
  await expect(read(operator(), offloadedUri)).rejects.toMatchObject({ code: -32002 });
});

test("unbound ordinary fixtures preserve generic reads and refuse product callers", async () => {
  expect(JSON.stringify(await read(operator(), unboundUri))).toContain(secret);
  await expect(read(owner, unboundUri)).rejects.toMatchObject({ code: -32002 });
});
