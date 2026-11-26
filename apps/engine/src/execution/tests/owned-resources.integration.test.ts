import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, ownedResources } from "../../db/schema/index.ts";
import { withTenantScope } from "../../db/tenant-scope.ts";
import { runExecution } from "../engine.ts";
import { recordCreatedResources, settleOwnedDelete } from "../persistence/owned-resources.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;
let connectorId = "";
let created = 0;
const hits: string[] = [];

const deletes = (id: string, collection = "jobs") =>
  hits.filter((hit) => hit === `DELETE /api/${collection}/${id}`);

beforeAll(async () => {
  ctx = await createEngineCtx("owned-resources");
  mock = await createMockServer(async (req, res) => {
    hits.push(`${req.method} ${req.url}`);
    for await (const _chunk of req) {
    }
    if (req.method === "POST" && req.url === "/api/jobs")
      return jsonResponse(res, 201, { id: `job-${++created}` });
    if (req.method === "POST" && req.url === "/api/fixed")
      return jsonResponse(res, 201, { id: "job-fixed" });
    if (req.method === "POST" && req.url === "/api/broken")
      return jsonResponse(res, 201, { id: "broken-1" });
    if (req.method === "POST" && req.url === "/api/items/search")
      return jsonResponse(res, 200, { ids: ["job-1", "job-2"] });
    if (req.method === "DELETE" && req.url === "/api/broken/broken-1")
      return jsonResponse(res, 503, { error: "unavailable" });
    if (req.method === "DELETE") return jsonResponse(res, 200, { ok: true });
    return jsonResponse(res, 404, { error: "not found" });
  });
  const [api] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "owned-jobs",
      display_name: "Owned jobs",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: `${mock.baseUrl}/api`,
      config: {},
    })
    .returning();
  connectorId = api!.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

const make = (path = "/jobs", id_path = "id") => ({
  kind: "request",
  id: "make",
  connector_id: connectorId,
  method: "POST",
  path,
  body: { name: "nightly" },
  records_created: { id_path },
});

const drop = (id: string, source: string, collection = "/jobs") => ({
  kind: "request",
  id,
  connector_id: connectorId,
  method: "DELETE",
  side_effects: "write",
  max_retries: 0,
  path: `${collection}/\${${source}}`,
  boundary: {
    variables: { [source]: { created_by_workflow: true } },
    max_body_bytes: 0,
    max_calls: 1,
    destructive: true,
  },
});

async function workflow(name: string, steps: unknown[]) {
  return (await createWorkflowRow(ctx, { name, steps })).workflow_id;
}

async function run(workflow_id: string, input: Record<string, unknown> = {}, hold = false) {
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input,
    ...(hold ? { options: { hold_writes: true } } : {}),
  });
  const output = (step: string) =>
    result.steps.find((entry) => entry.step_key === step)?.output_preview as
      | Record<string, unknown>
      | undefined;
  const failure = (step: string) =>
    (result.steps.find((entry) => entry.step_key === step)?.error as { code?: string } | null)
      ?.code;
  return { ...result, failure, output };
}

async function ledger(workflow_id: string) {
  return withTenantScope(ctx.testDb.db, ctx.tenantId, (tx) =>
    tx
      .select({
        resource_key: ownedResources.resource_key,
        collection_path: ownedResources.collection_path,
        state: ownedResources.state,
        environment: ownedResources.environment,
        connector_id: ownedResources.connector_id,
        created_step_id: ownedResources.created_step_id,
      })
      .from(ownedResources)
      .where(eq(ownedResources.workflow_id, workflow_id))
      .orderBy(ownedResources.resource_key),
  );
}

describe("governed DELETE of ids the workflow created", () => {
  test("a created id is recorded, removed once and a repeated removal replays", async () => {
    const lifecycle = await workflow("owned-lifecycle", [
      make(),
      drop("drop", "scope.make.data.id"),
      drop("drop_again", "scope.make.data.id"),
    ]);
    const result = await run(lifecycle);
    const id = `job-${created}`;
    expect(result.steps.find((step) => step.step_key === "drop")?.status).toBe("succeeded");
    expect(result.status).toBe("succeeded");
    expect(result.output("drop_again")).toMatchObject({
      replayed: true,
      outcome: "already_deleted",
      resource_keys: [id],
      replayed_from: [{ resource_key: id, execution_id: result.execution_id, step_id: "drop" }],
    });
    expect(deletes(id)).toHaveLength(1);
    expect(await ledger(lifecycle)).toEqual([
      {
        resource_key: id,
        collection_path: "/jobs",
        state: "deleted",
        environment: "dev",
        connector_id: connectorId,
        created_step_id: "make",
      },
    ]);
  });

  test("a later run removing the same id replays the stored outcome", async () => {
    const again = await workflow("owned-again", [
      make("/fixed"),
      drop("drop", "scope.make.data.id", "/fixed"),
    ]);
    const first = await run(again);
    expect(first.status).toBe("succeeded");
    const later = await run(again);
    expect(later.status).toBe("succeeded");
    expect(later.output("drop")).toMatchObject({
      replayed: true,
      replayed_from: [{ resource_key: "job-fixed", execution_id: first.execution_id }],
    });
    expect(deletes("job-fixed", "fixed")).toHaveLength(1);
    expect((await ledger(again)).map((row) => row.state)).toEqual(["deleted"]);
    const replays = await ctx.testDb.db
      .select({ resource_id: auditLog.resource_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "owned_resource.delete_replayed"),
          eq(auditLog.resource_id, later.execution_id),
        ),
      );
    expect(replays).toHaveLength(1);
  });

  test("an id this workflow did not create is refused before anything is sent", async () => {
    const creator = await workflow("owned-creator", [make()]);
    expect((await run(creator)).status).toBe("succeeded");
    const foreign = `job-${created}`;
    const remover = await workflow("owned-remover", [drop("drop", "input.id")]);
    for (const id of [foreign, "job-never-made"]) {
      const result = await run(remover, { id });
      expect(result.status).toBe("failed");
      expect(result.failure("drop")).toBe("delete_target_not_created_by_workflow");
      expect(deletes(id)).toHaveLength(0);
    }
    expect((await ledger(creator)).map((row) => row.state)).toEqual(["owned"]);
    expect(await ledger(remover)).toEqual([]);
  });

  test("an id is removable only under the collection that created it", async () => {
    const elsewhere = await workflow("owned-elsewhere", [
      make(),
      drop("drop", "scope.make.data.id", "/fixed"),
    ]);
    const result = await run(elsewhere);
    expect(result.failure("drop")).toBe("delete_target_not_created_by_workflow");
    expect(deletes(`job-${created}`, "fixed")).toHaveLength(0);
    expect((await ledger(elsewhere)).map((row) => row.state)).toEqual(["owned"]);
  });

  test("a PUT on an existing id cannot claim it", async () => {
    await expect(
      workflow("owned-claim", [
        { ...make("/jobs/${input.id}"), method: "PUT" },
        drop("drop", "input.id"),
      ]),
    ).rejects.toThrow("records_created_misplaced");
  });

  test("ids listed by a search are never recorded", async () => {
    const search = await workflow("owned-search", [make("/items/search", "ids")]);
    const result = await run(search);
    expect(result.failure("make")).toBe("created_resource_unrecorded");
    expect(await ledger(search)).toEqual([]);
  });

  test("a repeated create of the same id records it once", async () => {
    const repeat = await workflow("owned-repeat", [make("/fixed")]);
    expect((await run(repeat)).status).toBe("succeeded");
    expect((await run(repeat)).status).toBe("succeeded");
    expect((await ledger(repeat)).map((row) => row.resource_key)).toEqual(["job-fixed"]);
  });

  test("a removal without a confirmed outcome is never sent again", async () => {
    const broken = await workflow("owned-broken", [
      make("/broken"),
      drop("drop", "scope.make.data.id", "/broken"),
    ]);
    const first = await run(broken);
    expect(first.status).toBe("failed");
    expect((await ledger(broken)).map((row) => row.state)).toEqual(["delete_unknown"]);
    expect(first.failure("drop")).toBe("http_5xx");
    const replay = await run(broken);
    expect(replay.failure("drop")).toBe("delete_target_outcome_unknown");
    expect((await ledger(broken)).map((row) => row.state)).toEqual(["delete_unknown"]);
    expect(deletes("broken-1", "broken")).toHaveLength(1);
  });

  test("a preview that holds writes records nothing and claims nothing", async () => {
    const before = hits.length;
    const held = await workflow("owned-held", [make(), drop("drop", "scope.make.data.id")]);
    const result = await run(held, {}, true);
    expect(result.steps.find((step) => step.step_key === "make")?.held).toBe(true);
    expect(await ledger(held)).toEqual([]);
    expect(
      hits.slice(before).filter((hit) => hit.startsWith("POST") || hit.startsWith("DELETE")),
    ).toEqual([]);
  });
});

describe("ownership ledger", () => {
  test("recording is idempotent and settling is guarded by the reserving run", async () => {
    const owner = await workflow("owned-ledger", [make()]);
    const correlation = {
      collection_path: "/jobs",
      tenant_id: ctx.tenantId,
      workflow_id: owner,
      workflow_version_id: owner,
      environment: "dev" as const,
      connector_id: connectorId,
      execution_id: owner,
      step_id: "make",
    };
    expect(await recordCreatedResources(ctx.testDb.db, correlation, ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
    expect(await recordCreatedResources(ctx.testDb.db, correlation, ["a"])).toEqual([]);
    expect(await settleOwnedDelete(ctx.testDb.db, correlation, ["a"], "delete_confirmed")).toBe(0);
    expect((await ledger(owner)).map((row) => row.state)).toEqual(["owned", "owned"]);
  });
});
