import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { deriveShape, diffShapes, getLatestShape, recordSuccessShape } from "../service.ts";

let testDb: TestDb;
let tenantId: string;
let connectorId: string;

beforeAll(async () => {
  testDb = await createTestDb("schema_versions");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "schema-versions", display_name: "sv" })
    .returning();
  if (!t) throw new Error("tenant insert failed");
  tenantId = t.id;

  const [c] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: t.id,
      slug: "sv-conn",
      display_name: "sv",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      config: {},
    })
    .returning();
  if (!c) throw new Error("connector insert failed");
  connectorId = c.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("schema-versions/service", () => {
  test("deriveShape produces a recursive object shape", () => {
    const shape = deriveShape({
      id: 1,
      name: "Ada",
      tags: ["x", "y"],
      meta: { active: true },
    });
    expect(shape).toEqual({
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object", properties: { active: { type: "boolean" } } },
      },
    });
  });

  test("record + fetch round-trips the shape", async () => {
    const db = testDb.db;
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: "GET /users/1",
        value: { id: 1, name: "Ada" },
      },
      db,
    );
    const latest = await getLatestShape(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: "GET /users/1" },
      db,
    );
    expect(latest).toEqual({
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
      },
    });
  });

  test("subsequent record returns the newer shape", async () => {
    const db = testDb.db;
    // Avoid tying the ordering to millisecond clock precision: insert
    // the second row with a brief yield.
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: "GET /users/list",
        value: { items: [{ id: 1 }] },
      },
      db,
    );
    await new Promise((r) => setTimeout(r, 10));
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: "GET /users/list",
        value: { items: [{ id: 1, email: "a@b" }] },
      },
      db,
    );
    const latest = await getLatestShape(
      { tenant_id: tenantId, connector_id: connectorId, endpoint_key: "GET /users/list" },
      db,
    );
    // Newer shape carries the extra `email` key.
    expect(latest).toMatchObject({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              email: { type: "string" },
            },
          },
        },
      },
    });
  });

  test("diffShapes reports added / removed / widened at top level", () => {
    const before = deriveShape({ id: 1, name: "Ada" });
    const after = deriveShape({ id: "1", email: "a@b" });
    const diff = diffShapes(before, after);
    expect(diff.added).toContain("email");
    expect(diff.removed).toContain("name");
    expect(diff.widened).toContain("id"); // number -> string
  });
});
