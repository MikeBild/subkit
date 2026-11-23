import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import {
  dataMigrations,
  tenants,
  users,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { executableDefinition } from "../stored-definition.ts";
import {
  REQUEST_PROTOCOL_V1_BACKFILL_NAME,
  runRequestProtocolV1Backfill,
} from "./request-protocol-v1.ts";

let ctx: TestDb;
let tenantId: string;
let userId: string;

beforeAll(async () => {
  ctx = await createTestDb("request_protocol_backfill");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-request-protocol", display_name: "RequestProtocol" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "owner@example.test",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("seed user failed");
  userId = user.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

const storedGraphql = (name: string) => ({
  name,
  steps: [
    {
      id: "rows",
      kind: "request",
      method: "POST",
      url: "https://example.test/graphql",
      graphql: { query: "query { rows { id } }" },
    },
    { id: "read", kind: "request", method: "GET", url: "https://example.test/items" },
  ],
});

async function seed(slug: string, dag: Record<string, unknown>, approved = false) {
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug, name: slug, lifecycle: "active" })
    .returning();
  if (!workflow) throw new Error("workflow insert failed");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({ tenant_id: tenantId, workflow_id: workflow.id, version: 1, dag })
    .returning();
  if (!version) throw new Error("version insert failed");
  await ctx.db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, workflow.id)));
  if (approved)
    await ctx.db.insert(workflowExecutionAuthorities).values({
      tenant_id: tenantId,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      effect_manifest_digest: "0".repeat(64),
      effect_manifest: {},
      execution_environment: "dev",
      target_constraints: { targets: [] },
      created_by: userId,
    });
  return workflow.id;
}

async function versionsOf(workflow_id: string) {
  return ctx.db
    .select()
    .from(workflowVersions)
    .where(
      and(eq(workflowVersions.tenant_id, tenantId), eq(workflowVersions.workflow_id, workflow_id)),
    )
    .orderBy(asc(workflowVersions.version));
}

test("stored request steps gain their protocol; approved versions are replaced, never edited", async () => {
  const plain = await seed("protocol-plain", storedGraphql("plain"));
  const approved = await seed("protocol-approved", storedGraphql("approved"), true);
  const http = await seed("protocol-http", {
    name: "http",
    steps: [{ id: "read", kind: "request", method: "GET", url: "https://example.test/items" }],
  });
  const before = {
    plain: await versionsOf(plain),
    approved: await versionsOf(approved),
    http: await versionsOf(http),
  };
  expect(() => executableDefinition(before.plain[0]?.dag)).toThrow('`protocol: "graphql"`');
  await ctx.db
    .delete(dataMigrations)
    .where(eq(dataMigrations.name, REQUEST_PROTOCOL_V1_BACKFILL_NAME));

  const report = await runRequestProtocolV1Backfill(ctx.db);
  expect(report).toEqual({ skipped: false, rewritten: 1, rotated: 1, left_in_old_format: 0 });

  const plainAfter = await versionsOf(plain);
  expect(plainAfter).toHaveLength(1);
  expect(((plainAfter[0]?.dag ?? {}) as { steps?: unknown[] }).steps).toEqual([
    {
      id: "rows",
      kind: "request",
      method: "POST",
      url: "https://example.test/graphql",
      graphql: { query: "query { rows { id } }" },
      protocol: "graphql",
    },
    { id: "read", kind: "request", method: "GET", url: "https://example.test/items" },
  ]);
  expect(executableDefinition(plainAfter[0]?.dag).steps).toHaveLength(2);

  const approvedAfter = await versionsOf(approved);
  expect(approvedAfter).toHaveLength(2);
  expect(approvedAfter[0]?.dag).toEqual(before.approved[0]?.dag);
  const rotated = executableDefinition(approvedAfter[1]?.dag);
  expect(rotated.steps[0]).toMatchObject({ id: "rows", protocol: "graphql" });
  const [approvedRow] = await ctx.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, tenantId), eq(workflows.id, approved)));
  expect(approvedRow?.current_version_id).toBe(approvedAfter[1]?.id ?? "");

  expect(await versionsOf(http)).toEqual(before.http);
  expect(await runRequestProtocolV1Backfill(ctx.db)).toEqual({
    skipped: true,
    rewritten: 0,
    rotated: 0,
    left_in_old_format: 0,
  });
});
