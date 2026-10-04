// Stream 4 — build-time author permission warnings. A write step that
// targets a connector the author cannot write produces a non-blocking
// warning; read steps, connector-less steps, and writable connectors do not.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { tenants, users } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import * as grantsSvc from "../../rbac/grants.ts";
import { emptyRoleId } from "../../test-helpers/roles.ts";
import { authorConnectorWriteWarnings } from "./author-build-warnings.ts";

describe("authorConnectorWriteWarnings", () => {
  let testDb: TestDb;
  let db: Db;
  let tenantId: string;
  let userId: string;
  const connectorReadOnly = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const connectorWritable = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  beforeAll(async () => {
    testDb = await createTestDb("author-build-warnings");
    db = testDb.db;
    const [t] = await db.insert(tenants).values({ slug: "abw", display_name: "abw" }).returning();
    if (!t) throw new Error("seed tenant");
    tenantId = t.id;
    const [u] = await db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "author@abw",
        role_id: await emptyRoleId(db, tenantId),
      })
      .returning({ id: users.id });
    if (!u) throw new Error("seed user");
    userId = u.id;

    // read-only grant on one connector, read+write on the other.
    await grantsSvc.grantResource(db, {
      tenant_id: tenantId,
      subject_type: "user",
      subject_id: userId,
      resource_type: "connector",
      resource_id: connectorReadOnly,
      permission: "connector:read",
    });
    for (const permission of ["connector:read", "connector:write"]) {
      await grantsSvc.grantResource(db, {
        tenant_id: tenantId,
        subject_type: "user",
        subject_id: userId,
        resource_type: "connector",
        resource_id: connectorWritable,
        permission,
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (testDb) await testDb.cleanup();
  });

  // Bare principal (no role) — level reflects only the grants above.
  const author: () => ResolvedPrincipal = () => ({
    provider: "conversation_tool",
    kind: "user",
    id: userId,
    tenant_id: tenantId,
    roles: [],
  });

  test("warns on a write step against a read-only connector", async () => {
    const steps = [{ id: "s1", kind: "request", method: "POST", connector_id: connectorReadOnly }];
    const warnings = await authorConnectorWriteWarnings(db, author(), tenantId, steps);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("author_missing_permission");
    expect(warnings[0]?.step_key).toBe("s1");
    expect(warnings[0]?.message).toContain("read-only");
  });

  test("does not warn on a read step", async () => {
    const steps = [{ id: "s1", kind: "request", method: "GET", connector_id: connectorReadOnly }];
    expect(await authorConnectorWriteWarnings(db, author(), tenantId, steps)).toHaveLength(0);
  });

  test("does not warn on a write step against a writable connector", async () => {
    const steps = [{ id: "s1", kind: "request", method: "POST", connector_id: connectorWritable }];
    expect(await authorConnectorWriteWarnings(db, author(), tenantId, steps)).toHaveLength(0);
  });

  test("skips inline-url write steps that bind no connector_id", async () => {
    const steps = [{ id: "s1", kind: "request", method: "POST", url: "https://example.com" }];
    expect(await authorConnectorWriteWarnings(db, author(), tenantId, steps)).toHaveLength(0);
  });
});
