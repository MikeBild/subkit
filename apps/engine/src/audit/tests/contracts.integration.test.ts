import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import * as auditModule from "../audit.ts";
import { auditAwait } from "../audit.ts";
import { getAuditRowById, queryAuditLog, searchAuditResources, streamAuditLog } from "../query.ts";
import { tenantA, tenantB, testDb, useAuditContractsDb, uuid } from "./contracts-fixtures.ts";

useAuditContractsDb();

describe("audit append-only surface", () => {
  test("audit module exports no update / delete / mutate path", () => {
    const exported = Object.keys(auditModule);
    const banned = exported.filter((name) =>
      /^(update|delete|drop|patch|destroy|truncate|mutate)/i.test(name),
    );
    expect(banned).toEqual([]);
  });

  test("the public surface contains three append-only writers and actor normalization", () => {
    const functions = Object.keys(auditModule).filter(
      (k) =>
        typeof (auditModule as Record<string, unknown>)[k] === "function" && !k.startsWith("_"),
    );
    expect(functions.sort()).toEqual(
      ["audit", "auditAwait", "auditAwaitStandalone", "normalizeAuditActorId"].sort(),
    );
  });
});

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
    expect(aResult.items.some((e) => (e.metadata as { marker?: string }).marker === "A")).toBe(
      true,
    );
    expect(bResult.items.some((e) => (e.metadata as { marker?: string }).marker === "B")).toBe(
      true,
    );
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
    const wrongTenant = await getAuditRowById(testDb.db, tenantB, sample.id);
    expect(wrongTenant).toBeNull();
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

  test("resource search returns one current label per resource and keeps limit fair", async () => {
    const firstId = uuid();
    const secondId = uuid();
    const renamed = await auditAwait(
      {
        tenant_id: tenantA,
        action: "knowledge_source.updated",
        resource_type: "knowledge_source",
        resource_id: firstId,
        before: { name: "Vertragsarchiv" },
        after: { name: "Archiv 2026" },
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantA,
        ts: new Date(renamed.ts.getTime() + 1000),
        action: "catalog_metadata.generated",
        resource_type: "knowledge_source",
        resource_id: firstId,
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantA,
        action: "knowledge_source.created",
        resource_type: "knowledge_source",
        resource_id: secondId,
        after: { name: "Vertragsarchiv" },
      },
      testDb.db,
    );
    await auditAwait(
      {
        tenant_id: tenantB,
        action: "knowledge_source.created",
        resource_type: "knowledge_source",
        resource_id: uuid(),
        after: { name: "Vertragsarchiv" },
      },
      testDb.db,
    );
    const matches = await searchAuditResources(testDb.db, tenantA, "Vertragsarchiv", undefined, 2);
    expect(matches.map((match) => match.resource_id).sort()).toEqual([firstId, secondId].sort());
    expect(matches.find((match) => match.resource_id === firstId)?.resource_name).toBe(
      "Archiv 2026",
    );
    expect(matches.find((match) => match.resource_id === secondId)?.resource_name).toBe(
      "Vertragsarchiv",
    );
    const byId = await searchAuditResources(testDb.db, tenantA, firstId);
    expect(byId).toHaveLength(1);
    expect(byId[0]?.resource_name).toBe("Archiv 2026");
  });

  test("resource search cannot probe a secret hidden by the response projection", async () => {
    const resourceId = uuid();
    const event = await auditAwait(
      {
        tenant_id: tenantA,
        action: "knowledge_source.created",
        resource_type: "knowledge_source",
        resource_id: resourceId,
        after: { name: "Safe archive" },
      },
      testDb.db,
    );
    await testDb.db
      .update(auditLog)
      .set({ after: { name: `Safe archive ghp_${"A".repeat(32)}` } })
      .where(and(eq(auditLog.tenant_id, tenantA), eq(auditLog.id, event.id)));
    expect(await searchAuditResources(testDb.db, tenantA, "AAAAAAA")).toEqual([]);
    expect((await searchAuditResources(testDb.db, tenantA, "Safe archive"))[0]?.resource_id).toBe(
      resourceId,
    );
  });

  test("resource search reaches safe names after multiple pages of discarded secret matches", async () => {
    const tenant = await seedTenant(testDb.db, {
      slug: "audit-cn-search-late",
      display_name: "Audit Search Late",
    });
    const visibleId = uuid();
    await testDb.db.insert(auditLog).values({
      id: uuid(),
      ts: new Date(FROZEN_NOW),
      tenant_id: tenant.id,
      actor_type: "system",
      action: "knowledge_source.created",
      resource_type: "knowledge_source",
      resource_id: visibleId,
      result: "success",
      after: { name: "Archive AAAAAAA" },
      metadata: {},
    });
    await testDb.db.insert(auditLog).values(
      Array.from({ length: 150 }, (_, index) => ({
        id: uuid(),
        ts: new Date(FROZEN_NOW + (index + 1) * 1000),
        tenant_id: tenant.id,
        actor_type: "system",
        action: "knowledge_source.created",
        resource_type: "knowledge_source",
        resource_id: uuid(),
        result: "success",
        after: { name: `Archive ghp_${"A".repeat(32)} ${index}` },
        metadata: {},
      })),
    );
    const matches = await searchAuditResources(testDb.db, tenant.id, "AAAAAAA", undefined, 1);
    expect(matches.map((match) => match.resource_id)).toEqual([visibleId]);
    expect(matches[0]?.resource_name).toBe("Archive AAAAAAA");
  });

  test("resource search stops after a bounded number of discarded candidates", async () => {
    const tenant = await seedTenant(testDb.db, {
      slug: "audit-cn-search-cap",
      display_name: "Audit Search Cap",
    });
    const visibleId = uuid();
    await testDb.db.insert(auditLog).values({
      id: uuid(),
      ts: new Date(FROZEN_NOW),
      tenant_id: tenant.id,
      actor_type: "system",
      action: "knowledge_source.created",
      resource_type: "knowledge_source",
      resource_id: visibleId,
      result: "success",
      after: { name: "Archive BBBBBBB" },
      metadata: {},
    });
    for (let start = 0; start < 2_100; start += 250) {
      await testDb.db.insert(auditLog).values(
        Array.from({ length: Math.min(250, 2_100 - start) }, (_, index) => ({
          id: uuid(),
          ts: new Date(FROZEN_NOW + (start + index + 1) * 1000),
          tenant_id: tenant.id,
          actor_type: "system",
          action: "knowledge_source.created",
          resource_type: "knowledge_source",
          resource_id: uuid(),
          result: "success",
          after: { name: `Archive ghp_${"B".repeat(32)} ${start + index}` },
          metadata: {},
        })),
      );
    }
    expect(await searchAuditResources(testDb.db, tenant.id, "BBBBBBB", undefined, 1)).toEqual([]);
    expect((await searchAuditResources(testDb.db, tenant.id, visibleId))[0]?.resource_id).toBe(
      visibleId,
    );
  }, 30_000);
});

describe("transactional rollback", () => {
  test("auditAwait inside a rolled-back tx leaves no row on disk", async () => {
    const probeId = uuid();
    const probeMarker = `tx-rollback-${probeId}`;

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
        throw new Error("intentional rollback");
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toBe("intentional rollback");

    const rows = await testDb.db.select().from(auditLog).where(eq(auditLog.resource_id, probeId));
    expect(rows).toEqual([]);

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

describe("redaction across every payload field", () => {
  const PAT = "dop_v1_redactionmatrixabcdefabcdefabcdefabcdef";
  const JWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyZWRhY3Rpb25fbWF0cml4In0.signaturepart";
  const BEARER = "Bearer redaction.matrix-token_value";

  test("scrubs reason, metadata (top-level and nested), before, and after", async () => {
    const entry = await auditAwait(
      {
        tenant_id: tenantA,
        action: "vault.item.created",
        resource_type: "vault_item",
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

    expect(blob).toContain("REDACTED");
  });
});
