import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, ownedResources } from "../../db/schema/index.ts";
import { withTenantScope } from "../../db/tenant-scope.ts";
import { runExecution } from "../engine.ts";
import { recordCreatedResources, settleOwnedDelete } from "../persistence/owned-resources.ts";
import { isSensitivePayload } from "../sensitive-payload.ts";
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
const echoed: unknown[] = [];

const deletes = (id: string, collection = "jobs") =>
  hits.filter((hit) => hit === `DELETE /api/${collection}/${id}`);

beforeAll(async () => {
  ctx = await createEngineCtx("owned-resources");
  mock = await createMockServer(async (req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method === "POST" && req.url === "/api/echo") {
      echoed.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return jsonResponse(res, 200, { echoed: true });
    }
    if (req.method === "POST" && req.url === "/api/jobs")
      return jsonResponse(res, 201, { id: `job-${++created}` });
    if (req.method === "POST" && req.url === "/api/fixed")
      return jsonResponse(res, 201, { id: "job-fixed" });
    if (req.method === "POST" && req.url === "/api/legacy")
      return jsonResponse(res, 201, { id: "job-legacy" });
    if (req.method === "POST" && req.url === "/api/sealed")
      return jsonResponse(res, 201, { id: "job-sealed" });
    if (req.method === "POST" && req.url === "/api/broken")
      return jsonResponse(res, 201, { id: "broken-1" });
    if (req.method === "POST" && req.url === "/api/items/search")
      return jsonResponse(res, 200, { ids: ["job-1", "job-2"] });
    if (req.method === "DELETE" && req.url === "/api/broken/broken-1")
      return jsonResponse(res, 503, { error: "unavailable" });
    if (req.method === "DELETE")
      return jsonResponse(res, 200, { ok: true, removed: req.url, count: 1 });
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
    const step = (key: string) => result.steps.find((entry) => entry.step_key === key);
    expect(result.output("drop")).toEqual({ ok: true, removed: `/api/jobs/${id}`, count: 1 });
    expect(result.output("drop_again")).toEqual(result.output("drop"));
    expect(step("drop_again")?.request_meta).toEqual(step("drop")?.request_meta);
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

  const echo = {
    kind: "request",
    id: "echo",
    connector_id: "",
    method: "POST",
    path: "/echo",
    body: { removed: "${scope.drop.data.removed}", count: "${scope.drop.data.count}" },
  };

  test("a later run removing the same id replays the stored outcome", async () => {
    const again = await workflow("owned-again", [
      make("/fixed"),
      drop("drop", "scope.make.data.id", "/fixed"),
      { ...echo, connector_id: connectorId },
    ]);
    const echoedBefore = echoed.length;
    const first = await run(again);
    expect(first.status).toBe("succeeded");
    const later = await run(again);
    expect(later.status).toBe("succeeded");
    expect(later.output("drop")).toEqual(first.output("drop"));
    expect(echoed.slice(echoedBefore)).toEqual([
      { removed: "/api/fixed/job-fixed", count: 1 },
      { removed: "/api/fixed/job-fixed", count: 1 },
    ]);
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

  test("a removal confirmed before outputs were stored replays without output", async () => {
    const legacy = await workflow("owned-legacy", [
      make("/legacy"),
      drop("drop", "scope.make.data.id", "/legacy"),
    ]);
    expect((await run(legacy)).status).toBe("succeeded");
    await withTenantScope(ctx.testDb.db, ctx.tenantId, (tx) =>
      tx
        .update(ownedResources)
        .set({ deleted_result: null })
        .where(eq(ownedResources.workflow_id, legacy)),
    );
    const replay = await run(legacy);
    expect(replay.status).toBe("succeeded");
    expect(replay.output("drop") ?? null).toBeNull();
    expect(deletes("job-legacy", "legacy")).toHaveLength(1);
  });

  test("a sensitive workflow stores the removal outcome sealed and replays it", async () => {
    const sealed = (
      await createWorkflowRow(ctx, {
        name: "owned-sealed",
        execution_privacy: "sensitive",
        steps: [
          make("/sealed"),
          drop("drop", "scope.make.data.id", "/sealed"),
          { ...echo, connector_id: connectorId },
        ],
      })
    ).workflow_id;
    const echoedBefore = echoed.length;
    expect((await run(sealed)).status).toBe("succeeded");
    expect((await run(sealed)).status).toBe("succeeded");
    expect(deletes("job-sealed", "sealed")).toHaveLength(1);
    expect(echoed.slice(echoedBefore)).toEqual([
      { removed: "/api/sealed/job-sealed", count: 1 },
      { removed: "/api/sealed/job-sealed", count: 1 },
    ]);
    const [row] = await withTenantScope(ctx.testDb.db, ctx.tenantId, (tx) =>
      tx
        .select({ deleted_result: ownedResources.deleted_result })
        .from(ownedResources)
        .where(eq(ownedResources.workflow_id, sealed)),
    );
    expect(isSensitivePayload(row?.deleted_result)).toBe(true);
    expect(JSON.stringify(row?.deleted_result)).not.toContain("job-sealed");
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

  test("an owned removal that asks for retries is refused before anything is sent", async () => {
    const retried = await workflow("owned-retried", [
      make("/broken"),
      {
        ...drop("drop", "scope.make.data.id", "/broken"),
        max_retries: 3,
        retry_on_status: [503],
        retry_backoff_ms: 50,
      },
    ]);
    const before = deletes("broken-1", "broken").length;
    const result = await run(retried);
    expect(result.failure("drop")).toBe("created_by_workflow_misplaced");
    expect(deletes("broken-1", "broken")).toHaveLength(before);
    expect((await ledger(retried)).map((row) => row.state)).toEqual(["owned"]);
  });

  test("a paged removal sends nothing and keeps the id", async () => {
    const paged = await workflow("owned-paged", [
      make(),
      {
        ...drop("drop", "scope.make.data.id"),
        pagination: {
          strategy: "cursor",
          cursor_request_param: "start_cursor",
          cursor_response_path: "$.next_cursor",
          max_pages: 3,
        },
      },
    ]);
    const result = await run(paged);
    expect(result.failure("drop")).toBe("created_by_workflow_misplaced");
    expect(deletes(`job-${created}`)).toHaveLength(0);
    expect((await ledger(paged)).map((row) => row.state)).toEqual(["owned"]);
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
