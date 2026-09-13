// Resource-grant CRUD tests. The matrix test exercises the
// `grantResource` write path through the evaluator; this file covers
// `revokeResource`, `listGrants`, `listGrantsForSubject`, the unique
// constraint upsert, and the `permission_unknown` error path so the
// rbac/ coverage floor (90 % line / 85 % branch) holds without
// stretching the matrix file.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { Db } from "../../db/client.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import {
  type GrantInput,
  grantResource,
  listGrants,
  listGrantsForSubject,
  revokeResource,
} from "../grants.ts";

describe("rbac grants CRUD", () => {
  let testDb: TestDb;
  let db: Db;
  let tenantId: string;

  const subjectId = "11111111-1111-1111-1111-111111111111";
  const otherSubjectId = "22222222-2222-2222-2222-222222222222";
  const workflowAlpha = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const workflowBeta = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  beforeAll(async () => {
    testDb = await createTestDb("rbac-grants");
    db = testDb.db;
    const [t] = await db
      .insert(tenants)
      .values({ slug: "rbac-gr", display_name: "rbac-gr" })
      .returning();
    if (!t) throw new Error("seed tenant");
    tenantId = t.id;
  });

  afterAll(async () => {
    await testDb.cleanup();
  });

  function input(overrides: Partial<GrantInput> = {}): GrantInput {
    return {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: subjectId,
      resource_type: "workflow",
      resource_id: workflowAlpha,
      permission: "audit:read",
      ...overrides,
    };
  }

  test("grantResource returns the inserted row with permission_name populated", async () => {
    const row = await grantResource(db, input());
    expect(row.tenant_id).toBe(tenantId);
    expect(row.subject_id).toBe(subjectId);
    expect(row.permission_name).toBe("audit:read");
    expect(row.granted_by).toBeNull();
    expect(row.expires_at).toBeNull();
    expect(row.id).toBeDefined();
  });

  test("grantResource is idempotent on the unique constraint", async () => {
    const a = await grantResource(db, input({ resource_id: workflowBeta }));
    const b = await grantResource(db, input({ resource_id: workflowBeta }));
    expect(b.id).toBe(a.id);
  });

  test("grantResource refreshes expires_at on conflict", async () => {
    const future = new Date(FROZEN_NOW + 60 * 60 * 1000);
    await grantResource(db, input({ resource_id: workflowBeta, expires_at: null }));
    const updated = await grantResource(
      db,
      input({ resource_id: workflowBeta, expires_at: future }),
    );
    expect(updated.expires_at?.getTime()).toBe(future.getTime());
  });

  test("grantResource rejects unknown permissions with permission_unknown:<name>", async () => {
    await expect(grantResource(db, input({ permission: "nope:nope" }))).rejects.toThrow(
      "permission_unknown:nope:nope",
    );
  });

  test("listGrants returns every grant in the tenant", async () => {
    const all = await listGrants(db, tenantId);
    // Two distinct (subject, permission, resource) tuples from the
    // tests above. Each maps to one row.
    const resourceIds = all.map((g) => g.resource_id).sort();
    expect(resourceIds).toContain(workflowAlpha);
    expect(resourceIds).toContain(workflowBeta);
    for (const g of all) {
      expect(g.tenant_id).toBe(tenantId);
      expect(g.permission_name).toBe("audit:read");
    }
  });

  test("listGrantsForSubject scopes to the requested subject only", async () => {
    await grantResource(
      db,
      input({
        subject_id: otherSubjectId,
        resource_id: workflowAlpha,
        permission: "audit:read",
      }),
    );
    const ours = await listGrantsForSubject(db, tenantId, "user", subjectId);
    const others = await listGrantsForSubject(db, tenantId, "user", otherSubjectId);
    expect(ours.every((g) => g.subject_id === subjectId)).toBe(true);
    expect(others.every((g) => g.subject_id === otherSubjectId)).toBe(true);
    expect(ours.length).toBeGreaterThanOrEqual(2);
    expect(others.length).toBe(1);
  });

  test("listGrantsForSubject scopes to the subject_type", async () => {
    // Same subject_id but a different subject_type. Should yield zero
    // matches because we only inserted user-typed rows.
    const rows = await listGrantsForSubject(db, tenantId, "system_account", subjectId);
    expect(rows).toEqual([]);
  });

  test("revokeResource deletes the targeted row and returns true", async () => {
    const grant = await grantResource(
      db,
      input({ resource_id: "cccccccc-cccc-cccc-cccc-cccccccccccc" }),
    );
    const ok = await revokeResource(db, tenantId, grant.id);
    expect(ok).toBe(true);
    const rows = await listGrantsForSubject(db, tenantId, "user", subjectId);
    expect(rows.find((g) => g.id === grant.id)).toBeUndefined();
  });

  test("revokeResource returns false when the row is not in the tenant", async () => {
    const ok = await revokeResource(db, tenantId, "00000000-0000-0000-0000-000000000000");
    expect(ok).toBe(false);
  });

  test("revokeResource refuses to delete cross-tenant rows", async () => {
    const grant = await grantResource(
      db,
      input({ resource_id: "dddddddd-dddd-dddd-dddd-dddddddddddd" }),
    );
    const [otherTenant] = await db
      .insert(tenants)
      .values({ slug: "rbac-gr-2", display_name: "rbac-gr-2" })
      .returning();
    if (!otherTenant) throw new Error("seed second tenant");
    const ok = await revokeResource(db, otherTenant.id, grant.id);
    expect(ok).toBe(false);
    // Original row still resolvable.
    const stillThere = await listGrantsForSubject(db, tenantId, "user", subjectId);
    expect(stillThere.find((g) => g.id === grant.id)).toBeDefined();
  });
});
