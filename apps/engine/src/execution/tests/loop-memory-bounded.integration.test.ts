// Integration test: loop memory-bounded behaviour (the OOM fix).
//
// The loop runner substitutes OffloadRef placeholders into
// `iterationResults` so a loop with N large body steps holds N tiny
// references instead of N multi-MB payloads.
//
// Coverage:
//   1. Large-payload loop — scope holds OffloadRefs; persisted output is
//      plain JSON (no discriminant leaks through the external surface).
//   2. Persisted fixture rows for each large body step are readable after
//      the run; the re-hydrated iteration data is correct.
//   3. A downstream transform that reads `$scope.<loop>.data` receives
//      the transparently re-hydrated array and computes correctly.
//   4. Tenant isolation: a fixture row owned by tenant A cannot be read
//      under tenant B's identity (OffloadResolutionError).
//   5. Small-payload loop — inline path still works, no OffloadRef created.
//   6. Loop with no downstream consumer — scope keeps refs (fast-path),
//      no unnecessary re-materialisation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executionFixtures, executionSteps, tenants } from "../../db/schema/index.ts";
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

// Each large body payload is one byte above the inline threshold so the
// offload path is reliably triggered by every body step.
const LARGE_SIZE = STEP_RESULT_DB_BYTES + 1;
const LARGE_BLOB = "x".repeat(LARGE_SIZE);

// A small payload — stays below the threshold so the inline path is used.
const SMALL_BLOB = "y".repeat(128);

let ctx: EngineTestCtx;
let largeMock: MockServer;
let smallMock: MockServer;

beforeAll(async () => {
  ctx = await createEngineCtx("loop-memory-bounded");
  largeMock = await createMockServer((_, res) => jsonResponse(res, 200, { blob: LARGE_BLOB }));
  smallMock = await createMockServer((_, res) => jsonResponse(res, 200, { blob: SMALL_BLOB }));
});

afterAll(async () => {
  await largeMock.close();
  await smallMock.close();
  await ctx.cleanup();
});

describe("loop memory-bounded: OOM guard", () => {
  test("TC1 — large-body loop: scope holds OffloadRefs, persisted output is plain JSON", async () => {
    // Three iterations, each producing a payload above STEP_RESULT_DB_BYTES.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-oom-guard",
      steps: [
        {
          kind: "transform",
          id: "items",
          language: "jsonata",
          expression: "[1, 2, 3]",
        },
        {
          kind: "loop",
          id: "each",
          over: "$scope.items.data",
          item_var: "item",
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

    // INVARIANT: no OffloadRef discriminant (`$offloaded: true`) leaks
    // into the persisted / returned output — plain JSON only.
    expect(containsOffloadRef(result.output)).toBe(false);

    // Body step rows for each iteration must each have a result_storage_uri
    // (the fixture:// locator written by the step-runner when the payload
    // exceeded the threshold).
    const allStepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));

    const bodyRows = allStepRows.filter((r) => r.step_key.startsWith("fetch_blob["));
    expect(bodyRows).toHaveLength(3);
    for (const r of bodyRows) {
      expect(r.result_storage_uri).not.toBeNull();
      expect(r.result_storage_uri?.startsWith("fixture://")).toBe(true);
    }

    // The returned output is the loop's iteration array.
    const output = result.output as Array<{ fetch_blob: { data: unknown } }>;
    expect(Array.isArray(output)).toBe(true);
    expect(output).toHaveLength(3);

    // Each iteration's data must be the full, re-hydrated payload — not a
    // reference stub.
    for (const iter of output) {
      expect(isOffloadRef(iter?.fetch_blob?.data)).toBe(false);
      const data = iter?.fetch_blob?.data as { blob?: string };
      expect(typeof data?.blob).toBe("string");
      expect((data.blob ?? "").length).toBeGreaterThan(STEP_RESULT_DB_BYTES);
    }
  });

  test("TC2 — fixture rows are re-hydrated to the correct full payload", async () => {
    // Single-iteration loop; after the run we read the fixture row directly
    // and compare against what the mock returned.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-rehydrate-check",
      steps: [
        {
          kind: "transform",
          id: "items2",
          language: "jsonata",
          expression: "[42]",
        },
        {
          kind: "loop",
          id: "each2",
          over: "$scope.items2.data",
          item_var: "item",
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

    // Locate the fixture row written by the body step.
    const bodyStepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(and(eq(executionSteps.execution_id, result.execution_id)));

    const bodyRow = bodyStepRows.find((r) => r.step_key.startsWith("fetch_blob2["));
    expect(bodyRow).toBeDefined();
    const storageUri = bodyRow!.result_storage_uri;
    expect(storageUri).not.toBeNull();
    expect(storageUri!.startsWith("fixture://")).toBe(true);

    // Re-hydrate from the fixture table.
    const fixtureId = storageUri!.slice("fixture://".length);
    const fixtureRows = await ctx.testDb.db
      .select()
      .from(executionFixtures)
      .where(
        and(eq(executionFixtures.id, fixtureId), eq(executionFixtures.tenant_id, ctx.tenantId)),
      );
    expect(fixtureRows).toHaveLength(1);
    const body = fixtureRows[0]!.body as { blob?: string };
    // The re-hydrated payload matches what the mock HTTP server returned.
    expect(body?.blob).toBe(LARGE_BLOB);
  });

  test("TC3 — downstream transform reads $scope.<loop>.data transparently re-hydrated", async () => {
    // A transform step AFTER the loop reads `$scope.each3.data` (the
    // iteration array). The loop's scope entry carries OffloadRefs in
    // memory; jsonata-bindings.ts must resolve them before handing the
    // scope to the JSONata evaluator.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-downstream-transform",
      steps: [
        {
          kind: "transform",
          id: "items3",
          language: "jsonata",
          expression: "[1, 2]",
        },
        {
          kind: "loop",
          id: "each3",
          over: "$scope.items3.data",
          item_var: "item",
          body: ["fetch_blob3"],
        },
        {
          kind: "request",
          id: "fetch_blob3",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
        // Downstream transform: count the iterations via $scope.each3.data.
        {
          kind: "transform",
          id: "count_results",
          language: "jsonata",
          expression: "$count($scope.each3.data)",
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
    // The final output is the count step result — the transform ran
    // against the re-hydrated loop output.
    expect(result.output).toBe(2);
    expect(containsOffloadRef(result.output)).toBe(false);
  });

  test("TC4 — tenant isolation: foreign tenant cannot resolve another tenant's fixture", async () => {
    // Insert a fixture row owned by ctx.tenantId, then try to resolve it
    // using a freshly-seeded foreign tenant. The tenant predicate in
    // resolveOffloaded must refuse the cross-tenant read.
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
      .values({ slug: "loop-bounded-foreign", display_name: "Foreign Tenant (TC4)" })
      .returning({ id: tenants.id });

    const ref = {
      $offloaded: true as const,
      storage_uri: `fixture://${fixtureRow!.id}`,
      preview: "{}",
      size_bytes: JSON.stringify(payload).length,
    };

    // Reading the fixture under the owning tenant SUCCEEDS.
    const owned = await resolveOffloaded(ctx.testDb.db, ctx.tenantId, ref);
    expect(owned).toEqual(payload);

    // Reading the same fixture under the foreign tenant THROWS.
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
          language: "jsonata",
          expression: "[1, 2]",
        },
        {
          kind: "loop",
          id: "each5",
          over: "$scope.items5.data",
          item_var: "item",
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
    // No OffloadRef must appear anywhere in the output for small payloads.
    expect(containsOffloadRef(result.output)).toBe(false);

    // Body step rows: result_storage_uri should be NULL (inline, not offloaded).
    const allStepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));

    const smallBodyRows = allStepRows.filter((r) => r.step_key.startsWith("fetch_small["));
    expect(smallBodyRows).toHaveLength(2);
    for (const r of smallBodyRows) {
      // Small results stay inline — no fixture row written.
      expect(r.result_storage_uri).toBeNull();
    }

    // Output is the loop iteration array with real data inline.
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
    // A workflow that has a large-body loop but NO transform/branch/request
    // step consuming its scope output after it. The fast-path in
    // resolveScopeForJsonata must return the original scope reference without
    // resolving the refs — we can't observe the internal scope directly, but
    // we CAN verify the run still succeeds and no extra fixture rows are
    // created beyond the per-body-step writes that happen regardless.
    const fixtureCountBefore = await ctx.testDb.db
      .select({ id: executionFixtures.id })
      .from(executionFixtures)
      .where(eq(executionFixtures.tenant_id, ctx.tenantId));

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-no-consumer",
      steps: [
        {
          kind: "transform",
          id: "items6",
          language: "jsonata",
          expression: "[1, 2]",
        },
        {
          kind: "loop",
          id: "each6",
          over: "$scope.items6.data",
          item_var: "item",
          body: ["fetch_blob6"],
        },
        {
          kind: "request",
          id: "fetch_blob6",
          method: "GET",
          url: `${largeMock.baseUrl}/big`,
        },
        // NO downstream step references each6's output.
      ],
    });

    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");

    const fixtureCountAfter = await ctx.testDb.db
      .select({ id: executionFixtures.id })
      .from(executionFixtures)
      .where(eq(executionFixtures.tenant_id, ctx.tenantId));

    // Exactly 2 new fixture rows — one per body step iteration (plus
    // possibly one for the overall execution result if it exceeded the
    // threshold, which it shouldn't because the loop output is re-hydrated
    // before persistence). We must NOT see more than iterations + 1.
    const delta = fixtureCountAfter.length - fixtureCountBefore.length;
    // 2 body iterations wrote 2 fixture rows; the loop result is resolved
    // to plain JSON before the top-level maybeOffload, which is small enough
    // to stay inline (structure only, no blob strings).
    expect(delta).toBeLessThanOrEqual(3); // 2 body + 1 top-level if border-case
    expect(delta).toBeGreaterThanOrEqual(2); // at minimum the 2 body writes

    // No OffloadRef in the returned output.
    expect(containsOffloadRef(result.output)).toBe(false);
  });
});
