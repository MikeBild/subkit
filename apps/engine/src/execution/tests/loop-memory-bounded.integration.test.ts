// Integration test: loop memory-bounded behaviour (the OOM fix).
//
// The loop runner substitutes OffloadRef placeholders into
// `iterationResults` so a loop with N large body steps holds N tiny
// references instead of N multi-MB payloads.
//
// Coverage:
//   1. Large-payload loop — scope holds OffloadRefs; persisted output is
//      plain JSON (no discriminant leaks through the external surface).
//   2. Persisted object-store objects for each large body step are readable after
//      the run; the re-hydrated iteration data is correct.
//   3. A downstream transform that reads `$scope.<loop>.data` receives
//      the transparently re-hydrated array and computes correctly.
//   4. Legacy tenant isolation: a fixture row owned by tenant A cannot be read
//      under tenant B's identity (OffloadResolutionError).
//   5. Small-payload loop — inline path still works, no OffloadRef created.
//   6. Loop with no downstream consumer — scope keeps refs (fast-path),
//      no unnecessary re-materialisation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { executionFixtures, executionSteps, tenants } from "../../db/schema/index.ts";
import { getObjectStore } from "../../storage/object-store.ts";
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

    // INVARIANT: no OffloadRef discriminant (`$offloaded: true`) leaks
    // into the persisted / returned output — plain JSON only.
    expect(containsOffloadRef(result.output)).toBe(false);

    // Body step rows for each iteration must each have a result_storage_uri
    // (the s3:// locator written by the step-runner when the payload
    // exceeded the threshold).
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

  test("TC2 — object-store refs are re-hydrated to the correct full payload", async () => {
    // Single-iteration loop; after the run we resolve its immutable S3 ref
    // and compare against what the mock returned.
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

    // Locate the object-store reference written by the body step.
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
        // Downstream transform: count the iterations via $scope.each3.data.
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
    // A workflow with a large-body loop but NO transform/branch/request
    // step consuming its scope output. The fast-path in
    // resolveScopeForJsonata must return the original scope reference
    // without resolving the refs — we can't observe the internal scope
    // directly, but we CAN verify the run succeeds and that the number
    // of new immutable objects is EXACTLY accounted for.
    //
    // Size budget — this assertion is deterministic only because the
    // sizes below are pinned:
    //   * The loop is a SINGLE iteration. Its one body step fetches a
    //     payload of `LARGE_SIZE` (= STEP_RESULT_DB_BYTES + 1) bytes —
    //     one byte over the inline threshold — so the body step writes
    //     exactly ONE object.
    //   * `engine.ts` re-hydrates the loop output before the top-level
    //     `maybeOffload`. The re-hydrated top-level output is the
    //     single iteration's body payload (`LARGE_SIZE` bytes plus the
    //     surrounding envelope), which is ALSO above STEP_RESULT_DB_BYTES,
    //     so the aggregate write produces exactly ONE more object.
    //   * Total: 1 body row + 1 aggregate row = delta of exactly 2.
    // A second iteration would push the re-hydrated aggregate to ~2×
    // the body size and add a third row in a way that depends on the
    // exact envelope overhead — non-deterministic to assert. Keeping
    // the loop single-iteration pins the count.
    const prefix = `offload/${ctx.tenantId}/`;
    const objectCountBefore = (await getObjectStore().list(prefix)).length;

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

    const objectCountAfter = (await getObjectStore().list(prefix)).length;

    // Exactly 2 new objects: 1 body-step offload + 1 top-level
    // aggregate offload (see the size budget above). No off-by-one.
    const delta = objectCountAfter - objectCountBefore;
    expect(delta).toBe(2);

    // No OffloadRef in the returned output.
    expect(containsOffloadRef(result.output)).toBe(false);
  });

  test("TC7 — downstream LOOP iterates a prior loop's offloaded output (re-hydrated at the loop call site)", async () => {
    // An OUTER loop produces large body payloads (each iteration's body
    // step exceeds STEP_RESULT_DB_BYTES → offloaded, so the outer loop's
    // scope entry holds OffloadRefs). An INNER loop then iterates
    // `$scope.<outer>.data` — the outer loop's iteration array.
    //
    // TC3 covers a downstream TRANSFORM (the jsonata-bindings.ts call
    // site); this exercises `resolveScopeForJsonata` at the `loop.ts`
    // call site instead. The inner loop's `over` is a downstream
    // consumer of the scope, so its OffloadRefs MUST be re-hydrated
    // before the collection resolves — otherwise the inner loop would
    // iterate over reference stubs, not the real payloads.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-downstream-loop",
      steps: [
        {
          kind: "transform",
          id: "items7",
          language: "javascript",
          expression: "return [1, 2];",
        },
        // Outer loop: each iteration fetches a large blob → offloaded.
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
        // Inner loop: iterates the outer loop's iteration array. The
        // `over` expression reads `$scope.outer7.data`, which carries
        // OffloadRefs until resolveScopeForJsonata re-hydrates it.
        {
          kind: "loop",
          id: "inner7",
          over: "$scope.outer7.data",
          body: ["pick_blob7"],
        },
        // Inner body: extract the blob length from the re-hydrated row.
        // `row` is one outer-iteration envelope: { fetch_blob7: { data: { blob } } }.
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
    // No OffloadRef leaks into the persisted / returned output.
    expect(containsOffloadRef(result.output)).toBe(false);

    // The final output is the inner loop's iteration array — one entry
    // per outer-loop iteration. Each entry's `pick_blob7.data` is the
    // blob length, proving the inner loop saw the FULLY re-hydrated
    // outer-loop array (not reference stubs).
    const output = result.output as Array<{ pick_blob7: { data: unknown } }>;
    expect(Array.isArray(output)).toBe(true);
    expect(output).toHaveLength(2);
    for (const iter of output) {
      expect(isOffloadRef(iter?.pick_blob7?.data)).toBe(false);
      // Each inner iteration computed the length of a re-hydrated blob.
      expect(iter?.pick_blob7?.data).toBe(LARGE_SIZE);
    }
  });

  test("TC8 — top-level output_transform reads an offloaded loop's output (re-hydrated, not OffloadRef)", async () => {
    // `engine.ts` runs `deepResolveOffloadRefs` over the final output
    // BEFORE `output_transform`. The transform's JSONata root context
    // IS that final output — here the loop's iteration array, whose
    // entries' `fetch_blob8.data` were offloaded `OffloadRef`s in the
    // in-memory scope. The transform must see the real re-hydrated
    // blob string, never an `OffloadRef` stub. TC3/TC7 cover the
    // per-step JSONata sites; this covers the engine-level pipeline.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-output-transform",
      // The root context is the loop iteration array. Read the first
      // iteration's offloaded body blob and return its length. If the
      // transform saw an `OffloadRef` instead of the re-hydrated
      // payload, the ref has no `.blob` and `$length(...)` would
      // operate on `undefined` — the assertion below would fail.
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
    // The transform saw the FULL re-hydrated blob string — its length
    // equals the offloaded payload size, proving no `OffloadRef` stub
    // reached the output pipeline.
    expect(result.output).toBe(LARGE_SIZE);
    expect(containsOffloadRef(result.output)).toBe(false);
  });

  test("TC9 — top-level output_schema validates over an offloaded loop's re-hydrated output", async () => {
    // `output_schema` (required-field validation) also runs after
    // `deepResolveOffloadRefs` — and after `output_transform`. The
    // transform lifts the first iteration's offloaded body (root
    // context is the loop iteration array) so the schema has the
    // re-hydrated `{ blob }` object to inspect. An `OffloadRef`
    // reaching either stage has no `blob` key.
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

    // The run succeeds: `output_schema` saw the re-hydrated `{ blob }`
    // object and the `required: ["blob"]` check passed. An `OffloadRef`
    // reaching the validator would have no `blob` key and fail.
    expect(result.status).toBe("succeeded");
    expect(containsOffloadRef(result.output)).toBe(false);
    const out = result.output as { blob?: string };
    expect(out?.blob).toBe(LARGE_BLOB);
  });
});
