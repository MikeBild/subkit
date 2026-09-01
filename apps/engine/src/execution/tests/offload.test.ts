import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { executionFixtures, executionSteps, executions, tenants } from "../../db/schema/index.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { bodyEnvelopeForLoopAccumulator } from "../engine/envelope.ts";
import { runExecution } from "../engine.ts";
import {
  isOffloadRef,
  type OffloadRef,
  OffloadResolutionError,
  resolveOffloaded,
} from "../offload.ts";
import { containsOffloadRef, deepResolveOffloadRefs } from "../offload-rehydrate.ts";
import type { RunStepOutcome } from "../step-runner.ts";
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
const uuid = createDeterministicUuidFactory(0x0ff10ad);

beforeAll(async () => {
  ctx = await createEngineCtx("offload");
  // 12 KB string payload — exceeds 10KB threshold.
  const big = "x".repeat(12 * 1024);
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { blob: big }));
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("offload threshold", () => {
  test("large payload is offloaded into the common object store", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "big",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/big`,
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

    const stepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    expect(stepRows[0]?.result_storage_uri).not.toBeNull();
    expect(stepRows[0]?.result_storage_uri?.startsWith("s3://test/offload/")).toBe(true);
    expect(stepRows[0]?.result_preview?.length ?? 0).toBeGreaterThan(0);
    expect(stepRows[0]?.result_preview?.length ?? 0).toBeLessThanOrEqual(512);
    expect(stepRows[0]?.result_sha256).toMatch(/^[0-9a-f]{64}$/);

    const storageUri = stepRows[0]!.result_storage_uri!;
    const objectKey = storageUri.replace(/^s3:\/\/test\//, "");
    const objectBytes = await getObjectStore().get(objectKey);
    expect(createHash("sha256").update(objectBytes).digest("hex")).toBe(
      stepRows[0]!.result_sha256!,
    );

    const executionRows = await ctx.testDb.db
      .select({ result_sha256: executions.result_sha256 })
      .from(executions)
      .where(eq(executions.id, result.execution_id));
    expect(executionRows[0]?.result_sha256).toMatch(/^[0-9a-f]{64}$/);

    const fixturesRows = await ctx.testDb.db
      .select()
      .from(executionFixtures)
      .where(eq(executionFixtures.execution_id, result.execution_id));
    expect(fixturesRows).toHaveLength(0);
  });
});

describe("OffloadRef round-trip + resolveOffloaded", () => {
  test("isOffloadRef narrows only genuine refs", () => {
    expect(
      isOffloadRef({
        $offloaded: true,
        storage_uri: "fixture://x",
        preview: "",
        size_bytes: 1,
      }),
    ).toBe(true);
    expect(isOffloadRef({ $offloaded: false, storage_uri: "fixture://x" })).toBe(false);
    expect(isOffloadRef({ storage_uri: "fixture://x" })).toBe(false);
    expect(isOffloadRef(null)).toBe(false);
    expect(isOffloadRef("fixture://x")).toBe(false);
    expect(isOffloadRef({ $offloaded: true })).toBe(false);
  });

  test("resolveOffloaded re-hydrates a fixture:// ref to the original payload", async () => {
    const payload = { rows: [1, 2, 3], note: "hydrate-me" };
    const [row] = await ctx.testDb.db
      .insert(executionFixtures)
      .values({
        tenant_id: ctx.tenantId,
        kind: "offload",
        execution_id: null,
        step_id: null,
        body: payload,
        byte_size: 64,
      })
      .returning({ id: executionFixtures.id });
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: `fixture://${row!.id}`,
      preview: "{}",
      size_bytes: 64,
    };
    const resolved = await resolveOffloaded(ctx.testDb.db, ctx.tenantId, ref);
    expect(resolved).toEqual(payload);
  });

  test("resolveOffloaded REFUSES a cross-tenant fixture id", async () => {
    // A fixture owned by tenant A must not resolve under tenant B —
    // the `tenant_id` predicate is the isolation chokepoint.
    const [otherTenant] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "offload-other", display_name: "offload-other-tenant" })
      .returning({ id: tenants.id });
    const [row] = await ctx.testDb.db
      .insert(executionFixtures)
      .values({
        tenant_id: otherTenant!.id,
        kind: "offload",
        execution_id: null,
        step_id: null,
        body: { secret: "tenant-A-only" },
        byte_size: 32,
      })
      .returning({ id: executionFixtures.id });
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: `fixture://${row!.id}`,
      preview: "{}",
      size_bytes: 32,
    };
    // ctx.tenantId is a DIFFERENT tenant — must throw, never return the body.
    await expect(resolveOffloaded(ctx.testDb.db, ctx.tenantId, ref)).rejects.toBeInstanceOf(
      OffloadResolutionError,
    );
  });

  test("resolveOffloaded THROWS on a missing fixture — never returns undefined", async () => {
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: "fixture://00000000-0000-0000-0000-000000000000",
      preview: "{}",
      size_bytes: 1,
    };
    await expect(resolveOffloaded(ctx.testDb.db, ctx.tenantId, ref)).rejects.toBeInstanceOf(
      OffloadResolutionError,
    );
  });

  test("resolveOffloaded THROWS on a malformed fixture id", async () => {
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: "fixture://not-a-uuid",
      preview: "{}",
      size_bytes: 1,
    };
    await expect(resolveOffloaded(ctx.testDb.db, ctx.tenantId, ref)).rejects.toBeInstanceOf(
      OffloadResolutionError,
    );
  });

  test("resolveOffloaded THROWS on an s3:// ref when offload S3 is unconfigured", async () => {
    // The locator names a different bucket and therefore cannot be
    // honoured — it must throw, not fall back.
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: "s3://some-bucket/offload/key.json",
      preview: "{}",
      size_bytes: 1,
    };
    await expect(resolveOffloaded(ctx.testDb.db, ctx.tenantId, ref)).rejects.toBeInstanceOf(
      OffloadResolutionError,
    );
  });

  test("resolveOffloaded fails closed when application SHA-256 metadata mismatches", async () => {
    const key = `offload/integrity/${uuid()}.json`;
    const body = Buffer.from('{"integrity":"expected"}', "utf8");
    await getObjectStore().put(key, body);
    const ref: OffloadRef = {
      $offloaded: true,
      storage_uri: `s3://test/${key}`,
      preview: body.toString("utf8"),
      size_bytes: body.byteLength,
      sha256: "0".repeat(64),
    };

    await expect(resolveOffloaded(ctx.testDb.db, ctx.tenantId, ref)).rejects.toThrow(
      "application SHA-256 mismatch",
    );
  });

  test("deepResolveOffloadRefs re-hydrates refs nested in an array of objects", async () => {
    const payloadA = { a: 1 };
    const payloadB = { b: [9, 8, 7] };
    const rows = await ctx.testDb.db
      .insert(executionFixtures)
      .values([
        {
          tenant_id: ctx.tenantId,
          kind: "offload",
          body: payloadA,
          byte_size: 8,
        },
        {
          tenant_id: ctx.tenantId,
          kind: "offload",
          body: payloadB,
          byte_size: 16,
        },
      ])
      .returning({ id: executionFixtures.id });
    const mkRef = (id: string): OffloadRef => ({
      $offloaded: true,
      storage_uri: `fixture://${id}`,
      preview: "{}",
      size_bytes: 8,
    });
    // Shape mirrors a loop's iterationResults: array of iteration objects,
    // each holding body-step envelopes whose `.data` is an OffloadRef.
    const iterationResults = [
      { fetch: { data: mkRef(rows[0]!.id), error: null, duration_ms: 5 } },
      { fetch: { data: mkRef(rows[1]!.id), error: null, duration_ms: 7 } },
    ];
    expect(containsOffloadRef(iterationResults)).toBe(true);
    const resolved = (await deepResolveOffloadRefs(
      ctx.testDb.db,
      ctx.tenantId,
      iterationResults,
    )) as Array<{ fetch: { data: unknown } }>;
    expect(resolved[0]!.fetch.data).toEqual(payloadA);
    expect(resolved[1]!.fetch.data).toEqual(payloadB);
    expect(containsOffloadRef(resolved)).toBe(false);
  });

  test("deepResolveOffloadRefs returns the input untouched when nothing is offloaded", async () => {
    const plain = { a: 1, b: [2, 3], c: { d: "e" } };
    const resolved = await deepResolveOffloadRefs(ctx.testDb.db, ctx.tenantId, plain);
    // Same reference — a loop with no downstream consumer never re-materialises.
    expect(resolved).toBe(plain);
  });
});

describe("loop body offload — iterationResults hold references", () => {
  test("bodyEnvelopeForLoopAccumulator swaps a large body payload for an OffloadRef", () => {
    // A body step whose payload exceeded the inline threshold: the
    // step-runner already persisted it and surfaced result_storage_uri.
    const offloadedOutcome: RunStepOutcome = {
      result: { status: "succeeded", retry_count: 0, duration_ms: 12 },
      scope_value: { huge: "x".repeat(20_000) },
      result_storage_uri: "fixture://11111111-1111-1111-1111-111111111111",
      result_preview: '{"huge":"xxxx',
      result_size_bytes: 20_010,
    };
    const env = bodyEnvelopeForLoopAccumulator(offloadedOutcome);
    expect(isOffloadRef(env.data)).toBe(true);
    const ref = env.data as OffloadRef;
    expect(ref.storage_uri).toBe("fixture://11111111-1111-1111-1111-111111111111");
    expect(ref.size_bytes).toBe(20_010);
    // The small envelope fields stay inline — no re-hydration needed for them.
    expect(env.duration_ms).toBe(12);
    expect(env.error).toBeNull();
  });

  test("bodyEnvelopeForLoopAccumulator keeps a small body payload inline", () => {
    const smallOutcome: RunStepOutcome = {
      result: { status: "succeeded", retry_count: 0, duration_ms: 3 },
      scope_value: { tiny: "ok" },
      result_storage_uri: null,
      result_preview: null,
      result_size_bytes: 14,
    };
    const env = bodyEnvelopeForLoopAccumulator(smallOutcome);
    expect(isOffloadRef(env.data)).toBe(false);
    expect(env.data).toEqual({ tiny: "ok" });
  });

  test("a loop over large body envelopes yields references in iterationResults", async () => {
    // Two-iteration loop; each iteration's body request returns a 12 KB
    // blob (> 10 KB inline threshold). The run-resident iterationResults
    // must hold OffloadRefs, not the full payloads — and the persisted
    // execution result must be fully re-hydrated plain JSON.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-offload",
      steps: [
        {
          kind: "transform",
          id: "items",
          language: "javascript",
          expression: "return [1, 2];",
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
          url: `${mock.baseUrl}/big`,
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
    // The PERSISTED / returned result must be plain JSON — no OffloadRef
    // ever crosses the run boundary.
    expect(containsOffloadRef(result.output)).toBe(false);
    // Each per-iteration body step was offloaded individually.
    const stepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    const bodyRows = stepRows.filter((r) => r.step_key.startsWith("fetch_blob["));
    expect(bodyRows.length).toBe(2);
    for (const r of bodyRows) {
      expect(r.result_storage_uri?.startsWith("s3://test/offload/")).toBe(true);
    }
  });
});
