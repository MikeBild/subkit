// Audit subsystem contracts. These integration tests
// pin five invariants the audit log MUST hold for SOC2/ISO27001/GDPR
// evidence to be trustworthy:
//
//  1. Append-only API surface  — the audit module exports no update or
//                                delete path. (Existing source-level
//                                guarantee made testable.)
//  2. Tenant scoping            — queryAuditLog, getAuditRowById, and
//                                streamAuditLog all reject cross-tenant
//                                reads.
//  3. Transactional rollback    — passing a tx to auditAwait binds the
//                                audit row to the caller's transaction.
//                                A rollback of the domain change rolls
//                                the audit back too. (No half-commits.)
//  4. Redaction matrix          — every payload field that can carry
//                                user-provided strings is scrubbed
//                                before persist: reason, metadata
//                                (top-level and nested), before, after.
//  5. Request-source attribution — when callers pass `request_source` in
//                                metadata, it round-trips through the
//                                writer to the persisted row, so the
//                                forensic export can answer "did this
//                                action come from api / mcp / webhook /
//                                chat / cli / scheduler / tool-chain?".

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import * as auditModule from "../audit.ts";
import { auditAwait } from "../audit.ts";
import { getAuditRowById, queryAuditLog, serializeAuditEntry, streamAuditLog } from "../query.ts";
import { recordExecutionCrashRecovered } from "../recorders/execution.ts";
import { recordKnowledgeSourceCandidatesSynthesized } from "../recorders/knowledge.ts";
import { AuditAction } from "../types.ts";

// Deterministic uuid source for probe rows. Seeded so the test plays
// back identically run-to-run; using crypto.randomUUID would trip the
// `no-random-uuid-in-tests` determinism gate.
const uuid = createDeterministicUuidFactory(0xa11d11);

let testDb: TestDb;
let tenantA = "";
let tenantB = "";

beforeAll(async () => {
  testDb = await createTestDb("audit-contracts");
  const [a] = await testDb.db
    .insert(tenants)
    .values({ slug: "audit-cn-a", display_name: "Audit-Contracts A" })
    .returning();
  const [b] = await testDb.db
    .insert(tenants)
    .values({ slug: "audit-cn-b", display_name: "Audit-Contracts B" })
    .returning();
  if (!a || !b) throw new Error("seed tenants");
  tenantA = a.id;
  tenantB = b.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

// ---------- 1. append-only API surface ----------

describe("audit append-only surface", () => {
  test("audit module exports no update / delete / mutate path", () => {
    const exported = Object.keys(auditModule);
    const banned = exported.filter((name) =>
      /^(update|delete|drop|patch|destroy|truncate|mutate)/i.test(name),
    );
    expect(banned).toEqual([]);
  });

  test("the only writers are audit() and auditAwait()", () => {
    const writers = Object.keys(auditModule).filter(
      (k) =>
        typeof (auditModule as Record<string, unknown>)[k] === "function" &&
        // `_`-prefixed are test seams (e.g. `_drainAuditWritesForTests`), not
        // write paths — the invariant guards against a new PUBLIC writer.
        !k.startsWith("_"),
    );
    expect(writers.sort()).toEqual(["audit", "auditAwait"].sort());
  });
});

// ---------- 2. tenant scoping on every read path ----------

describe("tenant scoping on reads", () => {
  beforeAll(async () => {
    await auditAwait(
      {
        tenant_id: tenantA,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: tenantA,
        result: "success",
        metadata: { marker: "A" },
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantB,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: tenantB,
        result: "success",
        metadata: { marker: "B" },
      },
      testDb.db,
    );
  });

  test("queryAuditLog scopes to tenant_id", async () => {
    const aResult = await queryAuditLog(testDb.db, { tenant_id: tenantA });
    const bResult = await queryAuditLog(testDb.db, { tenant_id: tenantB });
    expect(aResult.items.every((e) => e.tenant_id === tenantA)).toBe(true);
    expect(bResult.items.every((e) => e.tenant_id === tenantB)).toBe(true);
    // Each tenant must see at least its own seed row.
    expect(aResult.items.some((e) => (e.metadata as { marker?: string }).marker === "A")).toBe(
      true,
    );
    expect(bResult.items.some((e) => (e.metadata as { marker?: string }).marker === "B")).toBe(
      true,
    );
    // And neither tenant must ever see the other's marker.
    expect(aResult.items.some((e) => (e.metadata as { marker?: string }).marker === "B")).toBe(
      false,
    );
    expect(bResult.items.some((e) => (e.metadata as { marker?: string }).marker === "A")).toBe(
      false,
    );
  });

  test("getAuditRowById refuses cross-tenant lookup", async () => {
    const aResult = await queryAuditLog(testDb.db, { tenant_id: tenantA });
    const sample = aResult.items[0];
    if (!sample) throw new Error("seed missing");
    // Same row id, but the wrong tenant — must come back null.
    const wrongTenant = await getAuditRowById(testDb.db, tenantB, sample.id);
    expect(wrongTenant).toBeNull();
    // Same row id with the right tenant comes back.
    const rightTenant = await getAuditRowById(testDb.db, tenantA, sample.id);
    expect(rightTenant?.id).toBe(sample.id);
  });

  test("streamAuditLog scopes to tenant_id", async () => {
    const collected: string[] = [];
    for await (const entry of streamAuditLog(testDb.db, { tenant_id: tenantA })) {
      collected.push(entry.tenant_id);
    }
    expect(collected.every((t) => t === tenantA)).toBe(true);
    expect(collected.length).toBeGreaterThan(0);
  });
});

// ---------- 3. transactional rollback ----------

describe("transactional rollback", () => {
  test("auditAwait inside a rolled-back tx leaves no row on disk", async () => {
    const probeId = uuid();
    const probeMarker = `tx-rollback-${probeId}`;

    // Wrap the audit insert in a tx that throws to force rollback.
    let caught: Error | null = null;
    try {
      await testDb.db.transaction(async (tx) => {
        await auditAwait(
          {
            tenant_id: tenantA,
            action: "tenant.created",
            resource_type: "tenant",
            resource_id: probeId,
            result: "success",
            metadata: { marker: probeMarker },
          },
          tx,
        );
        // Force the tx to roll back. Any throw inside the callback is
        // sufficient — drizzle/node-postgres will issue the ROLLBACK.
        throw new Error("intentional rollback");
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toBe("intentional rollback");

    // The audit row must NOT be on disk.
    const rows = await testDb.db.select().from(auditLog).where(eq(auditLog.resource_id, probeId));
    expect(rows).toEqual([]);

    // Sanity: the same insert WITHOUT a rolled-back tx must persist.
    await auditAwait(
      {
        tenant_id: tenantA,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: probeId,
        result: "success",
        metadata: { marker: `${probeMarker}-committed` },
      },
      testDb.db,
    );
    const after = await testDb.db.select().from(auditLog).where(eq(auditLog.resource_id, probeId));
    expect(after.length).toBe(1);
  });

  test("auditAwait inside a committed tx persists the row exactly once", async () => {
    const probeId = uuid();
    await testDb.db.transaction(async (tx) => {
      await auditAwait(
        {
          tenant_id: tenantA,
          action: "tenant.created",
          resource_type: "tenant",
          resource_id: probeId,
          result: "success",
          metadata: { marker: "tx-commit" },
        },
        tx,
      );
    });
    const rows = await testDb.db.select().from(auditLog).where(eq(auditLog.resource_id, probeId));
    expect(rows.length).toBe(1);
  });
});

// ---------- 4. redaction matrix ----------

describe("redaction across every payload field", () => {
  const PAT = "dop_v1_redactionmatrixabcdefabcdefabcdefabcdef";
  const JWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyZWRhY3Rpb25fbWF0cml4In0.signaturepart";
  const BEARER = "Bearer redaction.matrix-token_value";

  test("scrubs reason, metadata (top-level and nested), before, and after", async () => {
    const entry = await auditAwait(
      {
        tenant_id: tenantA,
        action: "credential.created",
        resource_type: "credential",
        resource_id: "redact-probe",
        result: "success",
        reason: `pasted ${PAT}`,
        metadata: {
          token: "should-be-replaced-top-level",
          notes: `JWT seen: ${JWT}`,
          headers: { authorization: BEARER },
          deeply: { nested: { still: { token: "should-be-replaced-deep" } } },
        },
        before: { previous_token: "should-be-replaced-before" },
        after: { new_token: "should-be-replaced-after", note: PAT },
      },
      testDb.db,
    );

    const persisted = await testDb.db.execute(
      sql`SELECT reason, metadata, before, after FROM audit_log WHERE id = ${entry.id}::uuid`,
    );
    const list = (
      persisted as unknown as {
        rows: Array<{
          reason: string | null;
          metadata: Record<string, unknown>;
          before: unknown;
          after: unknown;
        }>;
      }
    ).rows;
    const row = list[0];
    if (!row) throw new Error("row missing after persist");
    const blob = JSON.stringify(row);

    expect(blob).not.toContain(PAT);
    expect(blob).not.toContain(JWT);
    expect(blob).not.toContain(BEARER);
    expect(blob).not.toContain("should-be-replaced-top-level");
    expect(blob).not.toContain("should-be-replaced-deep");
    expect(blob).not.toContain("should-be-replaced-before");
    expect(blob).not.toContain("should-be-replaced-after");

    // A scrub marker survives so operators can spot a redaction
    // happened (instead of a silent drop).
    expect(blob).toContain("REDACTED");
  });
});

// ---------- 5. request-source attribution ----------

describe("request-source attribution", () => {
  // Audit metadata is a free-form bag; the contract is only that when
  // a caller passes `request_source` in metadata, the row faithfully
  // round-trips it. The engine does not REQUIRE request_source here;
  // route-boundary tests enforce that every state-changing route handler
  // actually populates the field on the way in. The assertion below pins
  // the round-trip property.
  const SOURCES = ["api", "cli", "mcp", "webhook", "tool-chain", "scheduler", "chat"] as const;

  for (const source of SOURCES) {
    test(`metadata.request_source=${source} round-trips to persisted row`, async () => {
      const probeId = uuid();
      const entry = await auditAwait(
        {
          tenant_id: tenantA,
          action: "tenant.created",
          resource_type: "tenant",
          resource_id: probeId,
          result: "success",
          metadata: { request_source: source, marker: `rs-${source}` },
        },
        testDb.db,
      );
      const fetched = await getAuditRowById(testDb.db, tenantA, entry.id);
      expect(fetched).not.toBeNull();
      expect((fetched?.metadata as { request_source?: string }).request_source).toBe(source);
    });
  }
});

// ---------- 6. query filter exhaustiveness ----------

describe("query filter coverage", () => {
  let actorId: string;
  let traceId: string;
  let resourceId: string;

  beforeAll(async () => {
    actorId = uuid();
    traceId = uuid();
    resourceId = uuid();
    // Three rows under tenantA with distinct (actor, resource, action,
    // result, trace_id) so every filter has something to match on.
    await auditAwait(
      {
        tenant_id: tenantA,
        actor_type: "user",
        actor_id: actorId,
        action: "credential.created",
        resource_type: "credential",
        resource_id: resourceId,
        result: "success",
        trace_id: traceId,
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantA,
        actor_type: "system",
        action: "credential.deleted",
        resource_type: "credential",
        resource_id: resourceId,
        result: "denied",
        reason: "not authorised",
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantA,
        actor_type: "user",
        actor_id: actorId,
        action: "workflow.created",
        resource_type: "workflow",
        result: "error",
      },
      testDb.db,
    );
  });

  test("actor_id filter narrows to that actor only", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, actor_id: actorId });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((e) => e.actor_id === actorId)).toBe(true);
  });

  test("actor_type filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, actor_type: "system" });
    expect(r.items.every((e) => e.actor_type === "system")).toBe(true);
  });

  test("resource_type filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, resource_type: "workflow" });
    expect(r.items.every((e) => e.resource_type === "workflow")).toBe(true);
  });

  test("resource_id filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, resource_id: resourceId });
    expect(r.items.every((e) => e.resource_id === resourceId)).toBe(true);
  });

  test("result filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, result: "denied" });
    expect(r.items.every((e) => e.result === "denied")).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
  });

  test("trace_id filter narrows correctly", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA, trace_id: traceId });
    expect(r.items.every((e) => e.trace_id === traceId)).toBe(true);
    expect(r.items.length).toBeGreaterThan(0);
  });

  test("actions[] filter is an OR over the array", async () => {
    const r = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      actions: ["credential.created", "credential.deleted"],
    });
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    expect(
      r.items.every((e) => e.action === "credential.created" || e.action === "credential.deleted"),
    ).toBe(true);
  });

  test("ts_from / ts_to bound the result set", async () => {
    // Insert one probe row with a deterministic ts at FROZEN_NOW so we
    // can bound a window around it without depending on wall-clock
    // timing. The other rows in this test use the audit writer's
    // default `new Date()` and live in the present, which lets us
    // verify both "inside-window matches" and "future-window empty".
    const probeTs = new Date(FROZEN_NOW);
    const probeId = uuid();
    await auditAwait(
      {
        tenant_id: tenantA,
        ts: probeTs,
        action: "tenant.created",
        resource_type: "tenant",
        resource_id: probeId,
        result: "success",
        metadata: { marker: "ts-bound-probe" },
      },
      testDb.db,
    );
    const past = new Date(FROZEN_NOW - 60 * 60 * 1000);
    const future = new Date(FROZEN_NOW + 60 * 60 * 1000);
    const insideWindow = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      ts_from: past,
      ts_to: future,
    });
    expect(
      insideWindow.items.some(
        (e) => (e.metadata as { marker?: string }).marker === "ts-bound-probe",
      ),
    ).toBe(true);
    const outsideWindow = await queryAuditLog(testDb.db, {
      tenant_id: tenantA,
      ts_from: past,
      ts_to: new Date(FROZEN_NOW - 30 * 60 * 1000),
    });
    expect(
      outsideWindow.items.some(
        (e) => (e.metadata as { marker?: string }).marker === "ts-bound-probe",
      ),
    ).toBe(false);
  });

  test("limit + before cursor walks pages newest-first", async () => {
    const first = await queryAuditLog(testDb.db, { tenant_id: tenantA }, { limit: 1 });
    expect(first.items.length).toBe(1);
    expect(first.next_cursor).not.toBeNull();
    const cursor = first.next_cursor!;
    const second = await queryAuditLog(
      testDb.db,
      { tenant_id: tenantA },
      { limit: 1, before: new Date(cursor) },
    );
    expect(second.items.length).toBe(1);
    if (first.items[0] && second.items[0]) {
      expect(first.items[0].ts.getTime()).toBeGreaterThanOrEqual(second.items[0].ts.getTime());
    }
  });

  test("limit caps at MAX_LIMIT (500) silently", async () => {
    // Pass a number above the cap; query must clamp without throwing.
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA }, { limit: 9999 });
    expect(Array.isArray(r.items)).toBe(true);
  });

  test("serializeAuditEntry produces a JSON-safe shape", async () => {
    const r = await queryAuditLog(testDb.db, { tenant_id: tenantA }, { limit: 1 });
    const entry = r.items[0];
    if (!entry) throw new Error("expected at least one row");
    const wire = serializeAuditEntry(entry);
    expect(typeof wire.ts).toBe("string");
    // Round-trips through JSON without throwing or losing info.
    const json = JSON.stringify(wire);
    expect(json).toContain(entry.id);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.tenant_id).toBe(tenantA);
  });
});

// ---------- 7. recorders not yet exercised by recorders.test.ts ----------

describe("recorder catalog gap fillers", () => {
  test("recordExecutionCrashRecovered persists with system actor + workflow_id metadata", async () => {
    const executionId = uuid();
    const workflowId = uuid();
    const entry = await recordExecutionCrashRecovered({
      tenant_id: tenantA,
      actor_id: null,
      executor: testDb.db,
      execution_id: executionId,
      workflow_id: workflowId,
      reason: "engine_boot_reaper",
      metadata: { started_at: "2026-05-03T00:00:00Z", timeout_ms: 30000 },
    });
    expect(entry.action).toBe(AuditAction.EXECUTION_CRASH_RECOVERED);
    expect(entry.actor_type).toBe("system");
    expect((entry.metadata as { workflow_id?: string }).workflow_id).toBe(workflowId);
    const fetched = await getAuditRowById(testDb.db, tenantA, entry.id);
    expect(fetched?.resource_id).toBe(executionId);
  });

  test("recordExecutionCrashRecovered tolerates a null workflow_id", async () => {
    const executionId = uuid();
    const entry = await recordExecutionCrashRecovered({
      tenant_id: tenantA,
      actor_id: null,
      executor: testDb.db,
      execution_id: executionId,
      workflow_id: null,
      reason: "engine_boot_reaper",
      metadata: { started_at: "2026-05-03T00:00:00Z" },
    });
    // No workflow_id key when the input is null.
    expect((entry.metadata as { workflow_id?: string }).workflow_id).toBeUndefined();
  });

  test("recordKnowledgeSourceCandidatesSynthesized records the LLM-synth path", async () => {
    const ksId = uuid();
    const sourceKsId = uuid();
    const entry = await recordKnowledgeSourceCandidatesSynthesized({
      tenant_id: tenantA,
      actor_id: null,
      executor: testDb.db,
      knowledge_source_id: ksId,
      source_knowledge_source_id: sourceKsId,
      candidate_count: 4,
      endpoint_count: 17,
      model_used: "claude-sonnet-4-6",
      reason: "file_analysis",
      created: true,
    });
    expect(entry.action).toBe(AuditAction.KNOWLEDGE_SOURCE_CANDIDATES_SYNTHESIZED);
    const meta = entry.metadata as {
      candidate_count?: number;
      endpoint_count?: number;
      model_used?: string;
      created?: boolean;
    };
    expect(meta.candidate_count).toBe(4);
    expect(meta.endpoint_count).toBe(17);
    expect(meta.model_used).toBe("claude-sonnet-4-6");
    expect(meta.created).toBe(true);
  });
});
