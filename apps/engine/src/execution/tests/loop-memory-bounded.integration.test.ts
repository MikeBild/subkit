import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executionFixtures, executionSteps, tenants } from "../../db/schema/index.ts";
import {
  type MemoryOffloadStorage,
  useMemoryOffloadStorage,
} from "../../test-helpers/offload-storage.ts";
import { runExecution } from "../engine.ts";
import { isOffloadRef, OffloadResolutionError, resolveOffloaded } from "../offload.ts";
import { containsOffloadRef } from "../offload-rehydrate.ts";
import { STEP_RESULT_DB_BYTES } from "../timeouts.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

const LARGE_SIZE = STEP_RESULT_DB_BYTES + 1;
const LARGE_BLOB = "x".repeat(LARGE_SIZE);

const SMALL_BLOB = "y".repeat(128);

let ctx: EngineTestCtx;
let storage: MemoryOffloadStorage;
let largeMock: MockServer;
let smallMock: MockServer;

beforeAll(async () => {
  storage = await useMemoryOffloadStorage();
  ctx = await createEngineCtx("loop-memory-bounded");
  largeMock = await createMockServer((_, res) => jsonResponse(res, 200, { blob: LARGE_BLOB }));
  smallMock = await createMockServer((_, res) => jsonResponse(res, 200, { blob: SMALL_BLOB }));
});

afterAll(async () => {
  await largeMock.close();
  await smallMock.close();
  await ctx.cleanup();
  await storage.restore();
});

describe("loop memory-bounded: OOM guard", () => {
  test("TC1 — large-body loop: scope holds OffloadRefs, persisted output is plain JSON", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-oom-guard",
      steps: [
        {
          kind: "transform",
          id: "items",
          language: "javascript",
          expression: "return [1, 2, 3];",
        },
        {
          kind: "loop",
          id: "each",
          over: "$scope.items.data",
          body: ["fetch_blob"],
        },
        {
          kind: "request",
          id: "fetch_blob",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");

    expect(containsOffloadRef(result.output)).toBe(false);

    const allStepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));

    const bodyRows = allStepRows.filter((r) => r.step_key.startsWith("fetch_blob["));
    expect(bodyRows).toHaveLength(3);
    for (const r of bodyRows) {
      expect(r.result_storage_uri).not.toBeNull();
      expect(r.result_storage_uri?.startsWith("s3://test/offload/")).toBe(true);
    }

    const output = result.output as Array<{ fetch_blob: { data: unknown } }>;
    expect(Array.isArray(output)).toBe(true);
    expect(output).toHaveLength(3);

    for (const iter of output) {
      expect(isOffloadRef(iter?.fetch_blob?.data)).toBe(false);
      const data = iter?.fetch_blob?.data as { blob?: string };
      expect(typeof data?.blob).toBe("string");
      expect((data.blob ?? "").length).toBeGreaterThan(STEP_RESULT_DB_BYTES);
    }
  });

  test("TC2 — object-store refs are re-hydrated to the correct full payload", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-rehydrate-check",
      steps: [
        {
          kind: "transform",
          id: "items2",
          language: "javascript",
          expression: "return [42];",
        },
        {
          kind: "loop",
          id: "each2",
          over: "$scope.items2.data",
          body: ["fetch_blob2"],
        },
        {
          kind: "request",
          id: "fetch_blob2",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");

    const bodyStepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(and(eq(executionSteps.execution_id, result.execution_id)));

    const bodyRow = bodyStepRows.find((r) => r.step_key.startsWith("fetch_blob2["));
    expect(bodyRow).toBeDefined();
    const storageUri = bodyRow!.result_storage_uri;
    expect(storageUri).not.toBeNull();
    expect(storageUri!.startsWith("s3://test/offload/")).toBe(true);

    const body = (await resolveOffloaded(ctx.testDb.db, ctx.tenantId, {
      $offloaded: true,
      storage_uri: storageUri!,
      preview: "{}",
      size_bytes: LARGE_SIZE,
    })) as { blob?: string };
    expect(body?.blob).toBe(LARGE_BLOB);
  });

  test("TC3 — downstream transform reads $scope.<loop>.data transparently re-hydrated", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-downstream-transform",
      steps: [
        {
          kind: "transform",
          id: "items3",
          language: "javascript",
          expression: "return [1, 2];",
        },
        {
          kind: "loop",
          id: "each3",
          over: "$scope.items3.data",
          body: ["fetch_blob3"],
        },
        {
          kind: "request",
          id: "fetch_blob3",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
        {
          kind: "transform",
          id: "count_results",
          language: "javascript",
          expression: "return (input.scope.each3.data || []).length;",
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toBe(2);
    expect(containsOffloadRef(result.output)).toBe(false);
  });

  test("TC4 — tenant isolation: foreign tenant cannot resolve another tenant's fixture", async () => {
    const payload = { secret: "owner-only", size: LARGE_BLOB.slice(0, 32) };
    const [fixtureRow] = await ctx.testDb.db
      .insert(executionFixtures)
      .values({
        tenant_id: ctx.tenantId,
        kind: "offload",
        execution_id: null,
        step_id: null,
        body: payload,
        byte_size: JSON.stringify(payload).length,
      })
      .returning({ id: executionFixtures.id });

    const [foreignTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({
        slug: "loop-bounded-foreign",
        display_name: "Foreign Tenant (TC4)",
      })
      .returning({ id: tenants.id });

    const ref = {
      $offloaded: true as const,
      storage_uri: `fixture://${fixtureRow!.id}`,
      preview: "{}",
      size_bytes: JSON.stringify(payload).length,
    };

    const owned = await resolveOffloaded(ctx.testDb.db, ctx.tenantId, ref);
    expect(owned).toEqual(payload);

    await expect(resolveOffloaded(ctx.testDb.db, foreignTenant!.id, ref)).rejects.toBeInstanceOf(
      OffloadResolutionError,
    );
  });

  test("TC5 — small-payload loop: inline path works, no OffloadRef in scope or output", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-small-inline",
      steps: [
        {
          kind: "transform",
          id: "items5",
          language: "javascript",
          expression: "return [1, 2];",
        },
        {
          kind: "loop",
          id: "each5",
          over: "$scope.items5.data",
          body: ["fetch_small"],
        },
        {
          kind: "request",
          id: "fetch_small",
          method: "GET",
          url: `${smallMock.baseUrl}/small`,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    expect(containsOffloadRef(result.output)).toBe(false);

    const allStepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));

    const smallBodyRows = allStepRows.filter((r) => r.step_key.startsWith("fetch_small["));
    expect(smallBodyRows).toHaveLength(2);
    for (const r of smallBodyRows) {
      expect(r.result_storage_uri).toBeNull();
    }

    const output = result.output as Array<{ fetch_small: { data: unknown } }>;
    expect(Array.isArray(output)).toBe(true);
    expect(output).toHaveLength(2);
    for (const iter of output) {
      expect(isOffloadRef(iter?.fetch_small?.data)).toBe(false);
      const data = iter?.fetch_small?.data as { blob?: string };
      expect(data?.blob).toBe(SMALL_BLOB);
    }
  });

  test("TC6 — loop with no downstream consumer never re-materialises refs (fast-path)", async () => {
    const prefix = `offload/${ctx.tenantId}/`;
    const objectCountBefore = (await storage.store.list(prefix)).length;

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-no-consumer",
      steps: [
        {
          kind: "transform",
          id: "items6",
          language: "javascript",
          expression: "return [1];",
        },
        {
          kind: "loop",
          id: "each6",
          over: "$scope.items6.data",
          body: ["fetch_blob6"],
        },
        {
          kind: "request",
          id: "fetch_blob6",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");

    const objectCountAfter = (await storage.store.list(prefix)).length;

    const delta = objectCountAfter - objectCountBefore;
    expect(delta).toBe(2);

    expect(containsOffloadRef(result.output)).toBe(false);
  });

  test("TC7 — downstream LOOP iterates a prior loop's offloaded output (re-hydrated at the loop call site)", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-downstream-loop",
      steps: [
        {
          kind: "transform",
          id: "items7",
          language: "javascript",
          expression: "return [1, 2];",
        },
        {
          kind: "loop",
          id: "outer7",
          over: "$scope.items7.data",
          body: ["fetch_blob7"],
        },
        {
          kind: "request",
          id: "fetch_blob7",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
        {
          kind: "loop",
          id: "inner7",
          over: "$scope.outer7.data",
          body: ["pick_blob7"],
        },
        {
          kind: "transform",
          id: "pick_blob7",
          language: "javascript",
          expression: "return input.scope.$item.fetch_blob7.data.blob.length;",
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    expect(containsOffloadRef(result.output)).toBe(false);

    const output = result.output as Array<{ pick_blob7: { data: unknown } }>;
    expect(Array.isArray(output)).toBe(true);
    expect(output).toHaveLength(2);
    for (const iter of output) {
      expect(isOffloadRef(iter?.pick_blob7?.data)).toBe(false);
      expect(iter?.pick_blob7?.data).toBe(LARGE_SIZE);
    }
  });

  test("TC8 — top-level output_transform reads an offloaded loop's output (re-hydrated, not OffloadRef)", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-output-transform",
      output_transform: "$length($[0].fetch_blob8.data.blob)",
      steps: [
        {
          kind: "transform",
          id: "items8",
          language: "javascript",
          expression: "return [1, 2];",
        },
        {
          kind: "loop",
          id: "each8",
          over: "$scope.items8.data",
          body: ["fetch_blob8"],
        },
        {
          kind: "request",
          id: "fetch_blob8",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toBe(LARGE_SIZE);
    expect(containsOffloadRef(result.output)).toBe(false);
  });

  test("TC9 — top-level output_schema validates over an offloaded loop's re-hydrated output", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-output-schema",
      output_transform: "$[0].fetch_blob9.data",
      output_schema: { type: "object", required: ["blob"] },
      steps: [
        {
          kind: "transform",
          id: "items9",
          language: "javascript",
          expression: "return [1];",
        },
        {
          kind: "loop",
          id: "each9",
          over: "$scope.items9.data",
          body: ["fetch_blob9"],
        },
        {
          kind: "request",
          id: "fetch_blob9",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    expect(containsOffloadRef(result.output)).toBe(false);
    const out = result.output as { blob?: string };
    expect(out?.blob).toBe(LARGE_BLOB);
  });
});
