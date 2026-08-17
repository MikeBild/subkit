import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, schemaVersions, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  deriveShape,
  diffShapes,
  getLatestShape,
  mergeObservedShapes,
  recordSuccessShape,
} from "../service.ts";

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
    await new Promise((r) => setTimeout(r, 10)); // allow-wall-clock: yields a tick so the schema-version writer commits before the read
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

  test("optional response fields accumulate without becoming removals", async () => {
    const variants = [
      [{ rows: [], dimensionHeaders: [] }, { rows: [] }],
      [{ messages: [], nextPageToken: "next" }, { messages: [] }],
      [{ data: {}, errors: [] }, { data: {} }],
      [{ daily: { time: [] } }, { current: { temperature: 20 } }],
    ] as const;
    for (const [withOptional, withoutOptional] of variants) {
      const accumulated = mergeObservedShapes(
        deriveShape(withOptional),
        deriveShape(withoutOptional),
      );
      expect(mergeObservedShapes(accumulated, deriveShape(withoutOptional))).toEqual(accumulated);
      expect(accumulated.type).toBe("object");
    }
  });

  test("recording is monotonic and isolated by workflow step provenance", async () => {
    const db = testDb.db;
    const workflowA = "11111111-1111-4111-8111-111111111111";
    const workflowB = "22222222-2222-4222-8222-222222222222";
    const endpoint = "POST /reports:runReport";
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: endpoint,
        workflow_id: workflowA,
        step_id: "ga4",
        value: { rows: [], dimensionHeaders: [] },
      },
      db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: endpoint,
        workflow_id: workflowA,
        step_id: "ga4",
        value: { rows: [] },
      },
      db,
    );
    await recordSuccessShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: endpoint,
        workflow_id: workflowB,
        step_id: "ga4",
        value: { rows: "incompatible" },
      },
      db,
    );

    const rows = await db
      .select()
      .from(schemaVersions)
      .where(
        and(
          eq(schemaVersions.tenant_id, tenantId),
          eq(schemaVersions.connector_id, connectorId),
          eq(schemaVersions.endpoint_key, endpoint),
        ),
      );
    expect(rows).toHaveLength(2);
    const shapeA = await getLatestShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: endpoint,
        workflow_id: workflowA,
        step_id: "ga4",
      },
      db,
    );
    const shapeB = await getLatestShape(
      {
        tenant_id: tenantId,
        connector_id: connectorId,
        endpoint_key: endpoint,
        workflow_id: workflowB,
        step_id: "ga4",
      },
      db,
    );
    expect(shapeA).toMatchObject({
      type: "object",
      properties: { dimensionHeaders: { type: "array" }, rows: { type: "array" } },
    });
    expect(shapeB).toMatchObject({
      type: "object",
      properties: { rows: { type: "string" } },
    });
  });

  test("incompatible concrete types widen to unknown", () => {
    const widened = mergeObservedShapes(deriveShape({ value: 1 }), deriveShape({ value: "one" }));
    expect(widened).toEqual({
      type: "object",
      properties: { value: { type: "unknown" } },
    });
    expect(mergeObservedShapes(widened, deriveShape({ value: 2 }))).toEqual(widened);
  });

  test("a collapsed root describes itself again on the next concrete response", () => {
    // One non-JSON body (an error page on a 200) collapses the whole contract.
    const collapsed = mergeObservedShapes(
      deriveShape({ data: { search: { nodes: [] } } }),
      deriveShape("<html>rate limited</html>"),
    );
    expect(collapsed).toEqual({ type: "unknown" });

    // Without recovery the row never changes again and the drift scan reports
    // the same collapse on every pass, forever.
    const healed = mergeObservedShapes(collapsed, deriveShape({ data: { ok: true } }));
    expect(healed).toMatchObject({ type: "object" });
  });

  test("a widened property still holds — only the root recovers", () => {
    const widened = mergeObservedShapes(deriveShape({ value: 1 }), deriveShape({ value: "one" }));
    expect(mergeObservedShapes(widened, deriveShape({ value: 2 }))).toEqual(widened);
  });

  test("empty arrays gain a concrete item shape when evidence arrives", () => {
    expect(
      mergeObservedShapes(deriveShape({ rows: [] }), deriveShape({ rows: [{ id: 1 }] })),
    ).toMatchObject({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: { id: { type: "number" } } } },
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
